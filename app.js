/* ====================================================================
   KHO TRUYỆN - Offline Vertical Comic Reader
   ==================================================================== */

// ==================== DATABASE ====================
class StoryDB {
  constructor() {
    this.dbName = 'KhoTruyenDB';
    this.dbVersion = 2;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('stories')) {
          const store = db.createObjectStore('stories', { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('images')) {
          const imgStore = db.createObjectStore('images', { keyPath: 'id' });
          imgStore.createIndex('storyId', 'storyId', { unique: false });
        }
        if (!db.objectStoreNames.contains('categories')) {
          const catStore = db.createObjectStore('categories', { keyPath: 'id' });
          catStore.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve();
      };

      request.onerror = (e) => reject(e.target.error);
    });
  }

  async addStory(story) {
    return this._transaction('stories', 'readwrite', (store) => store.put(story));
  }

  async getStory(id) {
    return this._transaction('stories', 'readonly', (store) => store.get(id));
  }

  async getAllStories() {
    return this._transaction('stories', 'readonly', (store) => store.getAll());
  }

  async deleteStory(id) {
    // Delete all images for this story
    const images = await this.getImagesByStory(id);
    const tx = this.db.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    for (const img of images) {
      store.delete(img.id);
    }
    await new Promise((resolve) => { tx.oncomplete = resolve; });

    // Clean up story reference from categories
    try {
      const categories = await this.getAllCategories();
      for (const cat of categories) {
        if (cat.storyIds && cat.storyIds.includes(id)) {
          cat.storyIds = cat.storyIds.filter((sId) => sId !== id);
          await this.addCategory(cat);
        }
      }
    } catch (err) {
      console.warn('Could not clean story from categories:', err);
    }
    
    return this._transaction('stories', 'readwrite', (store) => store.delete(id));
  }

  async addCategory(category) {
    return this._transaction('categories', 'readwrite', (store) => store.put(category));
  }

  async getCategory(id) {
    return this._transaction('categories', 'readonly', (store) => store.get(id));
  }

  async getAllCategories() {
    return this._transaction('categories', 'readonly', (store) => store.getAll());
  }

  async deleteCategory(id) {
    return this._transaction('categories', 'readwrite', (store) => store.delete(id));
  }

  async addImage(imageData) {
    return this._transaction('images', 'readwrite', (store) => store.put(imageData));
  }

  async getImagesByStory(storyId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('images', 'readonly');
      const store = tx.objectStore('images');
      const index = store.index('storyId');
      const request = index.getAll(storyId);
      request.onsuccess = () => {
        const images = request.result.sort((a, b) => a.order - b.order);
        resolve(images);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteImage(id) {
    return this._transaction('images', 'readwrite', (store) => store.delete(id));
  }

  async clearStoryImages(storyId) {
    const images = await this.getImagesByStory(storyId);
    const tx = this.db.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    for (const img of images) {
      store.delete(img.id);
    }
    return new Promise((resolve) => { tx.oncomplete = resolve; });
  }

  async clearAllData() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['stories', 'images', 'categories'], 'readwrite');
      tx.objectStore('stories').clear();
      tx.objectStore('images').clear();
      tx.objectStore('categories').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  _transaction(storeName, mode, callback) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const request = callback(store);
      if (request && request.onsuccess !== undefined) {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } else {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }
    });
  }
}

// ==================== APP ====================
class KhoTruyen {
  constructor() {
    this.db = new StoryDB();
    this.currentStory = null;
    this.editImages = []; // temp images for create/edit
    this.readerUIVisible = true;
    this.searchTerm = '';
    this.dragState = null;
    this.autoSort = true;
    this.selectedCategoryId = 'all';
    this.categories = [];
    this.currentCategoryEditId = null;
    this.categorySelectedStoryIds = new Set();
    this.storyAssignCategoryIds = new Set();
    this.currentMenuStoryId = null;
    this.objectUrlsToRevoke = new Set();
    this.batchDetectedFolders = [];
    this.lastLibraryScrollY = 0;
    this.lastViewedStoryId = null;
    this.currentStoryOrder = [];
    this.isStoragePersisted = false;
    this.storageEstimate = { usage: 0, quota: 0, percent: 0 };
    this.hitomiProxyUrl = localStorage.getItem('khotruyen_hitomi_proxy') || 'https://hread.kyanh1801.workers.dev';
    this.hitomiScannedGalleries = [];
    this.hitomiSelectedGalleryIds = new Set();
    this.hitomiAbortController = null;
    this.hitomiScannedTitle = '';
    this.hitomiLastScanUrl = '';
    this.hitomiTotalFound = 0;
    this.hitomiHasMore = false;
    this.hitomiNextOffset = 0;
    this.hitomiSubtitle = '';
    this._hitomiLoadingMore = false;
    this.gdriveClientId = localStorage.getItem('khotruyen_gdrive_client_id') || '';
    this.gdriveFolderName = localStorage.getItem('khotruyen_gdrive_folder_name') || 'KhoTruyen';
    this.gdriveAccessToken = null;
    this.gdriveTokenExpiresAt = 0;

    // Reader state & settings
    this.libraryPrefs = this.loadLibraryPrefs();
    this.readerSettings = this.loadReaderSettings();
    this._readerImages = [];
    this._readerPageUrls = new Map();
    this._readerPageHeights = new Map();
    this._readerScrollHandler = null;
    this._readerObserver = null;
    this._saveProgressTimer = null;
    this._scrubUnlockTimer = null;
    this._wakeLock = null;
    this._isScrubbing = false;
    this._isResuming = false;
    this._isExitingReader = false;
    this._allowPopstateExit = false;
    this._readerSessionId = 0;
    this._readerCurrentPage = 1;
    this._lastTapTime = 0;
    this._lastTapX = 0;
    this._lastTapY = 0;
    this._lastSwipeTime = 0;
    this._singleTapTimer = null;
  }

  loadLibraryPrefs() {
    const defaults = { readFilter: 'all', librarySort: 'updated' };
    try {
      const saved = JSON.parse(localStorage.getItem('khotruyen_library_prefs') || '{}');
      const readFilter = ['all', 'reading', 'unread', 'done'].includes(saved?.readFilter)
        ? saved.readFilter
        : defaults.readFilter;
      const librarySort = ['updated', 'recent-read', 'name'].includes(saved?.librarySort)
        ? saved.librarySort
        : defaults.librarySort;
      return { readFilter, librarySort };
    } catch (e) {
      return defaults;
    }
  }

  loadReaderSettings() {
    const defaults = {
      width: '',
      gap: 0,
      brightness: 100,
      warmth: 0,
      wakeLock: true,
      mode: 'vertical',
      tapZones: true,
    };
    try {
      const saved = JSON.parse(localStorage.getItem('khotruyen_reader_settings') || '{}');
      const merged = { ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) };
      if (!['vertical', 'single-rtl', 'single-ltr'].includes(merged.mode)) {
        merged.mode = defaults.mode;
      }
      return merged;
    } catch (e) {
      return defaults;
    }
  }

  createManagedUrl(blobOrData) {
    if (blobOrData instanceof Blob) {
      const url = URL.createObjectURL(blobOrData);
      this.objectUrlsToRevoke.add(url);
      return url;
    }
    return blobOrData; // already data URL or string
  }

  revokeManagedUrls() {
    for (const url of this.objectUrlsToRevoke) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    }
    this.objectUrlsToRevoke.clear();
  }

  async init() {
    await this.db.init();
    await this.checkAndRequestPersistence();
    this.bindEvents();
    this.showScreen('library');
    await this.loadLibrary();
    this.registerSW();
    this.updateStorageUI();
  }

  // ==================== STORAGE PERSISTENCE & MONITORING ====================
  async checkAndRequestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        let isPersisted = await navigator.storage.persisted();
        if (!isPersisted) {
          isPersisted = await navigator.storage.persist();
        }
        this.isStoragePersisted = !!isPersisted;
      } catch (err) {
        console.warn('Could not check storage persistence:', err);
        this.isStoragePersisted = false;
      }
    }
  }

  async requestPersistenceManually() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        const granted = await navigator.storage.persist();
        this.isStoragePersisted = !!granted;
        if (granted) {
          this.showToast('Đã kích hoạt bảo vệ lưu trữ vĩnh viễn ✓', 'success');
        } else {
          this.showToast('Trình duyệt chưa cấp quyền. Hãy cài đặt app ra màn hình chính!', 'error');
        }
        await this.updateStorageUI();
      } catch (e) {
        this.showToast('Không thể xin quyền: ' + e.message, 'error');
      }
    } else {
      this.showToast('Trình duyệt không hỗ trợ Persistent Storage API!', 'error');
    }
  }

  async updateStorageUI() {
    let usageFormatted = '0 MB';
    let quotaFormatted = 'Không rõ';
    let percent = 0;
    let isPersisted = this.isStoragePersisted;

    if (navigator.storage) {
      if (navigator.storage.persisted) {
        try {
          isPersisted = await navigator.storage.persisted();
          this.isStoragePersisted = isPersisted;
        } catch (e) {}
      }

      if (navigator.storage.estimate) {
        try {
          const estimate = await navigator.storage.estimate();
          const usageMB = (estimate.usage || 0) / (1024 * 1024);
          const quotaMB = (estimate.quota || 0) / (1024 * 1024);

          if (usageMB >= 1024) {
            usageFormatted = `${(usageMB / 1024).toFixed(1)} GB`;
          } else {
            usageFormatted = `${usageMB.toFixed(1)} MB`;
          }

          if (quotaMB >= 1024) {
            quotaFormatted = `${(quotaMB / 1024).toFixed(1)} GB`;
          } else {
            quotaFormatted = `${Math.round(quotaMB)} MB`;
          }

          percent = quotaMB > 0 ? Math.min(100, Math.round((usageMB / quotaMB) * 100)) : 0;
          this.storageEstimate = { usage: estimate.usage || 0, quota: estimate.quota || 0, percent };
        } catch (e) {}
      }
    }

    // Update hero badge
    const heroStatus = document.getElementById('hero-storage-status');
    if (heroStatus) {
      heroStatus.innerHTML = isPersisted
        ? `🛡️ Vĩnh viễn (${usageFormatted})`
        : `⚠️ Tạm thời (${usageFormatted})`;
      heroStatus.title = isPersisted
        ? `Đã bật bảo vệ vĩnh viễn. Đã dùng: ${usageFormatted} / ${quotaFormatted}`
        : `Chưa bật bảo vệ vĩnh viễn! Bấm vào để khoá bảo vệ`;
    }

    // Update backup modal card
    const pill = document.getElementById('storage-shield-pill');
    const desc = document.getElementById('storage-shield-desc');
    const persistBtn = document.getElementById('storage-persist-btn');
    const icon = document.getElementById('storage-status-icon');
    const usageText = document.getElementById('storage-usage-text');
    const percentText = document.getElementById('storage-percent-text');
    const barFill = document.getElementById('storage-meter-bar-fill');

    if (pill) {
      if (isPersisted) {
        pill.className = 'storage-shield-pill persisted';
        pill.innerHTML = '🛡️ Đã khoá bảo vệ';
        if (desc) desc.textContent = 'Dữ liệu truyện đã được khoá an toàn. Chrome và điện thoại sẽ không bao giờ tự ý xoá.';
        if (persistBtn) persistBtn.style.display = 'none';
        if (icon) icon.textContent = '🛡️';
      } else {
        pill.className = 'storage-shield-pill warning';
        pill.innerHTML = '⚠️ Bộ nhớ tạm';
        if (desc) desc.textContent = 'Trình duyệt có thể tự xoá truyện khi máy gần hết bộ nhớ. Hãy bấm nút bên dưới để khoá bảo vệ!';
        if (persistBtn) persistBtn.style.display = 'flex';
        if (icon) icon.textContent = '⚠️';
      }
    }

    if (usageText) usageText.textContent = `Đã dùng: ${usageFormatted} / ${quotaFormatted}`;
    if (percentText) percentText.textContent = `${percent}%`;
    if (barFill) {
      barFill.style.width = `${Math.max(1, percent)}%`;
      barFill.className = 'storage-meter-bar-fill';
      if (percent > 85) barFill.classList.add('danger');
      else if (percent > 70) barFill.classList.add('warning');
    }
  }

  registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  // ==================== NAVIGATION ====================
  showScreen(name, preserveScroll = false) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    const screen = document.getElementById(`screen-${name}`);
    if (screen) {
      screen.classList.add('active');
      screen.style.animation = 'none';
      screen.offsetHeight; // trigger reflow
      screen.style.animation = '';
    }

    // Reset scroll unless preserveScroll is true
    if (!preserveScroll) {
      window.scrollTo(0, 0);
    }
  }

  // ==================== LIBRARY ====================
  saveLibraryPrefs() {
    try {
      localStorage.setItem('khotruyen_library_prefs', JSON.stringify(this.libraryPrefs));
    } catch (e) {}
  }

  async setReadFilter(filter) {
    if (!['all', 'reading', 'unread', 'done'].includes(filter)) return;
    this.libraryPrefs.readFilter = filter;
    this.saveLibraryPrefs();
    this.syncLibraryFilterUI();
    await this.loadLibrary();
  }

  async setLibrarySort(sort) {
    if (!['updated', 'recent-read', 'name'].includes(sort)) return;
    this.libraryPrefs.librarySort = sort;
    this.saveLibraryPrefs();
    this.syncLibraryFilterUI();
    await this.loadLibrary();
  }

  syncLibraryFilterUI() {
    const { readFilter, librarySort } = this.libraryPrefs;
    document.querySelectorAll('.filter-pill[data-read-filter]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.readFilter === readFilter);
    });
    const sortSelect = document.getElementById('library-sort-select');
    if (sortSelect) {
      sortSelect.value = librarySort;
    }
  }

  sortStoriesList(stories) {
    const sortMode = this.libraryPrefs?.librarySort || 'updated';
    const list = [...stories];
    if (sortMode === 'name') {
      list.sort((a, b) =>
        (a.name || '').localeCompare(b.name || '', 'vi', { numeric: true, sensitivity: 'base' })
      );
    } else if (sortMode === 'recent-read') {
      list.sort(
        (a, b) =>
          (b.lastReadAt || b.updatedAt || b.createdAt || 0) -
          (a.lastReadAt || a.updatedAt || a.createdAt || 0)
      );
    } else {
      list.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    }
    return list;
  }

  async loadLibrary() {
    this.syncLibraryFilterUI();
    this.categories = await this.db.getAllCategories();
    const allStories = this.sortStoriesList(await this.db.getAllStories());

    // Render category pills
    this.renderCategoryPills(allStories);

    // Filter by category
    let storiesToShow = allStories;
    const activeBar = document.getElementById('active-category-bar');

    if (this.selectedCategoryId !== 'all') {
      const currentCat = this.categories.find((c) => c.id === this.selectedCategoryId);
      if (currentCat) {
        const catStorySet = new Set(currentCat.storyIds || []);
        storiesToShow = allStories.filter((s) => catStorySet.has(s.id));

        if (activeBar) {
          activeBar.style.display = 'flex';
          const nameEl = document.getElementById('active-category-name');
          const countEl = document.getElementById('active-category-count');
          if (nameEl) nameEl.textContent = currentCat.name;
          if (countEl) countEl.textContent = `${storiesToShow.length} truyện`;
        }
      } else {
        this.selectedCategoryId = 'all';
        if (activeBar) activeBar.style.display = 'none';
      }
    } else {
      if (activeBar) activeBar.style.display = 'none';
    }

    // Filter by search term
    let filtered = this.searchTerm
      ? storiesToShow.filter((s) => s.name.toLowerCase().includes(this.searchTerm.toLowerCase()))
      : storiesToShow;

    // Filter by read status
    const readFilter = this.libraryPrefs?.readFilter || 'all';
    if (readFilter !== 'all') {
      filtered = filtered.filter((s) => {
        const total = s.imageCount || 0;
        const lastPage = s.lastReadPage || 0;
        if (readFilter === 'reading') return lastPage > 1 && lastPage < total;
        if (readFilter === 'unread') return !lastPage || (lastPage <= 1 && !(total === 1 && s.lastReadAt));
        if (readFilter === 'done') return total > 0 && lastPage >= total && (total > 1 || Boolean(s.lastReadAt));
        return true;
      });
    }

    // Ensure final sort & update ordered story list for Prev/Next navigation
    filtered = this.sortStoriesList(filtered);
    this.currentStoryOrder = filtered.map((s) => s.id);

    // Update stats
    const statsEl = document.getElementById('library-stats');
    const totalImages = allStories.reduce((sum, s) => sum + (s.imageCount || 0), 0);
    const storageUsage = this.storageEstimate?.usage
      ? (this.storageEstimate.usage >= 1024 * 1024 * 1024 
          ? `${(this.storageEstimate.usage / (1024 * 1024 * 1024)).toFixed(1)} GB`
          : `${(this.storageEstimate.usage / (1024 * 1024)).toFixed(0)} MB`)
      : '0 MB';

    const storageBadgeHtml = `
      <div class="stat-badge storage-stat-badge" onclick="app.openBackupModal()" title="Xem trạng thái bảo vệ & bộ nhớ">
        <span class="stat-num" id="hero-storage-status">${this.isStoragePersisted ? `🛡️ Vĩnh viễn (${storageUsage})` : `⚠️ Tạm thời (${storageUsage})`}</span>
      </div>
    `;

    if (this.selectedCategoryId === 'all') {
      statsEl.innerHTML = `
        <div class="stat-badge">
          <span class="stat-num">${allStories.length}</span> truyện
        </div>
        <div class="stat-badge">
          <span class="stat-num">${totalImages}</span> ảnh
        </div>
        ${storageBadgeHtml}
      `;
    } else {
      statsEl.innerHTML = `
        <div class="stat-badge">
          <span class="stat-num">${storiesToShow.length}</span> / ${allStories.length} truyện
        </div>
        <div class="stat-badge">
          <span class="stat-num">${this.categories.length}</span> danh mục
        </div>
        ${storageBadgeHtml}
      `;
    }

    // Render grid
    const grid = document.getElementById('story-grid');
    
    if (filtered.length === 0) {
      if (this.searchTerm) {
        grid.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">🔍</div>
            <h3>Không tìm thấy</h3>
            <p>Thử tìm kiếm với từ khác</p>
          </div>
        `;
      } else if (readFilter !== 'all') {
        grid.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📖</div>
            <h3>Không có truyện phù hợp</h3>
            <p>Chưa có truyện nào khớp bộ lọc trạng thái hiện tại.</p>
            <button class="btn btn-primary" style="margin-top: 14px; padding: 10px 18px; font-size: 0.85rem;" onclick="app.setReadFilter('all')">
              Xem tất cả
            </button>
          </div>
        `;
      } else if (this.selectedCategoryId !== 'all') {
        const currentCat = this.categories.find((c) => c.id === this.selectedCategoryId);
        grid.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📁</div>
            <h3>Danh mục trống</h3>
            <p>Danh mục "${this.escapeHTML(currentCat ? currentCat.name : '')}" chưa có truyện nào.</p>
            <button class="btn btn-primary" style="margin-top: 14px; padding: 10px 18px; font-size: 0.85rem;" onclick="app.editCurrentCategory()">
              ➕ Thêm truyện vào danh mục
            </button>
          </div>
        `;
      } else {
        grid.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📚</div>
            <h3>Chưa có truyện nào</h3>
            <p>Nhấn nút + để tạo truyện mới<br>và bắt đầu bộ sưu tập của bạn!</p>
          </div>
        `;
      }
      return;
    }

    grid.innerHTML = filtered
      .map((story) => {
        const total = story.imageCount || 0;
        const lastPage = story.lastReadPage || 0;
        const progressBadge =
          lastPage > 1 && total > 0
            ? lastPage >= total
              ? '<span class="story-progress-badge done">✓ Đã đọc</span>'
              : `<span class="story-progress-badge">📖 ${lastPage}/${total}</span>`
            : '';
        const bookmarkBadge =
          Array.isArray(story.bookmarks) && story.bookmarks.length > 0
            ? `<span class="story-bookmark-badge">★ ${story.bookmarks.length}</span>`
            : '';

        return `
      <div class="story-card" data-id="${story.id}" onclick="app.openStory('${story.id}')" oncontextmenu="event.preventDefault(); app.showStoryMenu('${story.id}')">
        <div class="story-cover">
          ${
            story.coverData
              ? `<img src="${story.coverData}" alt="${this.escapeHTML(story.name)}" loading="lazy">`
              : `<div class="cover-placeholder">
                  <div class="cover-icon">📖</div>
                  <div class="cover-text">Chưa có ảnh bìa</div>
                </div>`
          }
        </div>
        <div class="story-info">
          <div class="story-title">${this.escapeHTML(story.name)}</div>
          <div class="story-meta">
            <span class="story-chapter-badge">
              🖼 ${total}
            </span>
            ${progressBadge}
            ${bookmarkBadge}
          </div>
        </div>
      </div>
    `;
      })
      .join('');
  }

  renderCategoryPills(allStories) {
    const container = document.getElementById('category-pills');
    if (!container) return;

    const allStoryIds = new Set(allStories.map((s) => s.id));

    let html = `
      <button class="category-chip ${this.selectedCategoryId === 'all' ? 'active' : ''}" onclick="app.selectCategory('all')">
        <span>🌐 Tất cả</span>
        <span class="category-chip-count">${allStories.length}</span>
      </button>
    `;

    for (const cat of this.categories) {
      const count = (cat.storyIds || []).filter((id) => allStoryIds.has(id)).length;
      const isActive = this.selectedCategoryId === cat.id;
      html += `
        <button class="category-chip ${isActive ? 'active' : ''}" onclick="app.selectCategory('${cat.id}')">
          <span>🏷️ ${this.escapeHTML(cat.name)}</span>
          <span class="category-chip-count">${count}</span>
        </button>
      `;
    }

    html += `
      <button class="category-chip add-chip" onclick="app.openCategoryModal()">
        <span>➕ Danh mục</span>
      </button>
    `;

    container.innerHTML = html;
  }

  // ==================== CREATE / EDIT ====================
  exitCreate() {
    this.revokeManagedUrls();
    this.showScreen('library', true);
  }

  openCreate() {
    this.revokeManagedUrls();
    this.currentStory = null;
    this.editImages = [];
    this.autoSort = true;
    document.getElementById('auto-sort-toggle').checked = true;
    this.updateSortToggleStyle();
    document.getElementById('create-title').textContent = 'Tạo truyện mới';
    document.getElementById('story-name-input').value = '';
    document.getElementById('delete-story-btn').style.display = 'none';
    this.renderEditImages();
    this.showScreen('create');
  }

  async openEdit(storyId) {
    const story = await this.db.getStory(storyId);
    if (!story) return;

    this.revokeManagedUrls();
    this.currentStory = story;
    const images = await this.db.getImagesByStory(storyId);
    this.editImages = images.map((img) => ({
      id: img.id,
      name: img.name,
      data: img.data,
      previewUrl: this.createManagedUrl(img.data),
      order: img.order,
    }));

    this.autoSort = false;
    document.getElementById('auto-sort-toggle').checked = false;
    this.updateSortToggleStyle();
    document.getElementById('create-title').textContent = 'Chỉnh sửa truyện';
    document.getElementById('story-name-input').value = story.name;
    document.getElementById('delete-story-btn').style.display = 'flex';
    this.renderEditImages();
    this.showScreen('create');
  }

  renderEditImages() {
    const list = document.getElementById('image-list');
    const count = document.getElementById('image-count');
    count.textContent = `${this.editImages.length} ảnh`;

    if (this.editImages.length === 0) {
      list.innerHTML = '';
      return;
    }

    list.innerHTML = this.editImages
      .map(
        (img, idx) => `
      <div class="image-item" data-index="${idx}" draggable="true">
        <div class="drag-handle">
          <span></span><span></span><span></span>
        </div>
        <img class="image-thumb" src="${img.previewUrl || this.createManagedUrl(img.data)}" alt="Trang ${idx + 1}">
        <div class="image-info">
          <div class="image-name">${this.escapeHTML(img.name || `Trang ${idx + 1}`)}</div>
          <div class="image-order">Trang ${idx + 1} / ${this.editImages.length}</div>
        </div>
        <button class="image-remove" onclick="app.removeEditImage(${idx})">✕</button>
      </div>
    `
      )
      .join('');

    // Setup drag & drop for reordering
    this.setupDragDrop();
  }

  setupDragDrop() {
    const items = document.querySelectorAll('.image-item');
    
    items.forEach((item) => {
      // Touch events for mobile
      let touchStartY = 0;
      let touchCurrentY = 0;
      let dragIndex = -1;
      let placeholder = null;

      item.addEventListener('touchstart', (e) => {
        if (e.target.closest('.image-remove')) return;
        const handle = e.target.closest('.drag-handle');
        if (!handle) return;

        dragIndex = parseInt(item.dataset.index);
        touchStartY = e.touches[0].clientY;
        item.classList.add('dragging');
      }, { passive: true });

      item.addEventListener('touchmove', (e) => {
        if (dragIndex === -1) return;
        e.preventDefault();
        touchCurrentY = e.touches[0].clientY;

        const allItems = [...document.querySelectorAll('.image-item')];
        allItems.forEach((el) => el.classList.remove('drag-over'));

        const target = document.elementFromPoint(
          e.touches[0].clientX,
          e.touches[0].clientY
        );
        const targetItem = target?.closest('.image-item');
        if (targetItem && targetItem !== item) {
          targetItem.classList.add('drag-over');
        }
      }, { passive: false });

      item.addEventListener('touchend', (e) => {
        if (dragIndex === -1) return;
        item.classList.remove('dragging');

        const target = document.elementFromPoint(
          e.changedTouches[0].clientX,
          e.changedTouches[0].clientY
        );
        const targetItem = target?.closest('.image-item');

        if (targetItem && targetItem !== item) {
          const targetIndex = parseInt(targetItem.dataset.index);
          this.reorderImages(dragIndex, targetIndex);
        }

        document.querySelectorAll('.image-item').forEach((el) => el.classList.remove('drag-over'));
        dragIndex = -1;
      });

      // Desktop drag events
      item.addEventListener('dragstart', (e) => {
        if (e.target.closest('.image-remove')) {
          e.preventDefault();
          return;
        }
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.index);
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        document.querySelectorAll('.image-item').forEach((el) => el.classList.remove('drag-over'));
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        item.classList.add('drag-over');
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over');
      });

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
        const toIndex = parseInt(item.dataset.index);
        if (fromIndex !== toIndex) {
          this.reorderImages(fromIndex, toIndex);
        }
        document.querySelectorAll('.image-item').forEach((el) => el.classList.remove('drag-over'));
      });
    });
  }

  reorderImages(fromIndex, toIndex) {
    const [moved] = this.editImages.splice(fromIndex, 1);
    this.editImages.splice(toIndex, 0, moved);
    this.renderEditImages();
  }

  async handleFileSelect(files) {
    if (!files || files.length === 0) return;

    const fileArr = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (fileArr.length === 0) {
      this.showToast('Chỉ hỗ trợ file ảnh!', 'error');
      return;
    }

    // Sort new files by name for natural order
    fileArr.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    for (const file of fileArr) {
      // Store File directly as Blob - saves ~33% memory and storage size!
      this.editImages.push({
        id: this.generateId(),
        name: file.name,
        data: file,
        previewUrl: this.createManagedUrl(file),
        order: this.editImages.length,
      });
    }

    // Apply auto-sort if enabled
    if (this.autoSort) {
      this.sortImagesByNumber();
    }

    this.renderEditImages();
    this.showToast(`Đã thêm ${fileArr.length} ảnh ✓`, 'success');
  }

  readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  removeEditImage(index) {
    this.editImages.splice(index, 1);
    this.renderEditImages();
  }

  // Extract number from filename for sorting
  // Prioritizes 1-3 digit numbers at the START of the filename
  extractNumber(filename) {
    // Remove extension
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
    
    // Priority: find 1-3 digit number at the START of the filename
    const leadingMatch = nameWithoutExt.match(/^(\d{1,3})(?:\D|$)/);
    if (leadingMatch) {
      return parseInt(leadingMatch[1], 10);
    }

    // Fallback: find any numbers in the filename
    const matches = nameWithoutExt.match(/(\d+)/g);
    if (matches) {
      return parseInt(matches[matches.length - 1], 10);
    }
    return Infinity; // No number found, put at end
  }

  sortImagesByNumber() {
    this.editImages.sort((a, b) => {
      const numA = this.extractNumber(a.name);
      const numB = this.extractNumber(b.name);
      if (numA !== numB) return numA - numB;
      // If same number, sort by full name
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }

  toggleAutoSort() {
    this.autoSort = document.getElementById('auto-sort-toggle').checked;
    this.updateSortToggleStyle();

    if (this.autoSort && this.editImages.length > 0) {
      this.sortImagesByNumber();
      this.renderEditImages();
      this.showToast('Đã sắp xếp theo số ✓', 'success');
    }
  }

  updateSortToggleStyle() {
    const container = document.getElementById('sort-toggle-container');
    if (this.autoSort) {
      container.classList.add('active');
    } else {
      container.classList.remove('active');
    }
  }

  async saveStory() {
    const nameInput = document.getElementById('story-name-input');
    const name = nameInput.value.trim();

    if (!name) {
      this.showToast('Vui lòng nhập tên truyện!', 'error');
      nameInput.focus();
      return;
    }

    if (this.editImages.length === 0) {
      this.showToast('Vui lòng thêm ít nhất 1 ảnh!', 'error');
      return;
    }

    const storyId = this.currentStory ? this.currentStory.id : this.generateId();
    const now = Date.now();

    try {
      // Generate cover from first image (thumbnail)
      const coverData = await this.generateThumbnail(this.editImages[0].data, 300, 400);

      const story = {
        ...(this.currentStory || {}),
        id: storyId,
        name: name,
        coverData: coverData,
        imageCount: this.editImages.length,
        createdAt: this.currentStory ? this.currentStory.createdAt : now,
        updatedAt: now,
      };

      await this.db.addStory(story);

      // Clear old images if editing
      if (this.currentStory) {
        await this.db.clearStoryImages(storyId);
      }

      // Save images
      for (let i = 0; i < this.editImages.length; i++) {
        await this.db.addImage({
          id: this.editImages[i].id || this.generateId(),
          storyId: storyId,
          name: this.editImages[i].name,
          data: this.editImages[i].data,
          order: i,
        });
      }

      this.revokeManagedUrls();
      this.showToast(this.currentStory ? 'Đã cập nhật truyện ✓' : 'Đã tạo truyện mới ✓', 'success');
      this.showScreen('library');
      await this.loadLibrary();
      this.updateStorageUI();
    } catch (err) {
      console.error('Save story error:', err);
      if (err.name === 'QuotaExceededError' || err.message?.toLowerCase().includes('quota')) {
        alert('Bộ nhớ điện thoại / trình duyệt đã đầy (QuotaExceededError)! Vui lòng xoá bớt truyện hoặc xuất file sao lưu trước khi lưu thêm.');
      } else {
        this.showToast('Lỗi khi lưu truyện: ' + err.message, 'error');
      }
    }
  }

  async generateThumbnail(dataOrBlob, maxW, maxH) {
    return new Promise((resolve) => {
      const img = new Image();
      const isBlob = dataOrBlob instanceof Blob;
      const url = isBlob ? URL.createObjectURL(dataOrBlob) : dataOrBlob;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width;
        let h = img.height;
        
        if (w > maxW || h > maxH) {
          const ratio = Math.min(maxW / w, maxH / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        if (isBlob) URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => {
        if (isBlob) URL.revokeObjectURL(url);
        resolve('');
      };
      img.src = url;
    });
  }

  async deleteStory(storyId) {
    const id = storyId || (this.currentStory && this.currentStory.id);
    if (!id) return;

    await this.db.deleteStory(id);
    this.showToast('Đã xoá truyện ✓', 'success');
    this.closeModal();
    this.showScreen('library');
    await this.loadLibrary();
    this.updateStorageUI();
  }

  // ==================== READER ====================
  isSinglePageMode() {
    const mode = this.readerSettings?.mode || 'vertical';
    return mode === 'single-rtl' || mode === 'single-ltr';
  }

  toggleReaderSettings(forceState) {
    const panel = document.getElementById('reader-settings-panel');
    if (!panel) return;
    const shouldOpen = typeof forceState === 'boolean' ? forceState : !panel.classList.contains('open');
    panel.classList.toggle('open', shouldOpen);
    const btn = document.getElementById('reader-settings-btn');
    if (btn) btn.classList.toggle('active', shouldOpen);
    if (shouldOpen) {
      this.applyReaderSettings();
      this.updateBookmarkUI();
    }
  }

  setReaderSetting(key, value) {
    this.readerSettings = { ...this.readerSettings, [key]: value };
    try {
      localStorage.setItem('khotruyen_reader_settings', JSON.stringify(this.readerSettings));
    } catch (e) {}
    this.applyReaderSettings();

    if (key === 'wakeLock') {
      const readerScreen = document.getElementById('screen-reader');
      if (value && readerScreen?.classList.contains('active')) {
        this.requestWakeLock();
      } else if (!value) {
        this.releaseWakeLock();
      }
    } else if (key === 'mode') {
      const readerScreen = document.getElementById('screen-reader');
      if (readerScreen?.classList.contains('active') && this.currentStory) {
        this.syncReaderModeView();
      }
    }
  }

  applyReaderSettings() {
    const screen = document.getElementById('screen-reader');
    const content = document.getElementById('reader-content');
    const { width, gap, brightness, warmth, wakeLock, mode, tapZones } = this.readerSettings;
    const activeMode = ['vertical', 'single-rtl', 'single-ltr'].includes(mode) ? mode : 'vertical';
    const isSingle = activeMode === 'single-rtl' || activeMode === 'single-ltr';

    if (screen) {
      screen.classList.toggle('reader-mode-vertical', !isSingle);
      screen.classList.toggle('reader-mode-single', isSingle);
      if (width) {
        screen.style.setProperty('--reader-max-width', width);
      } else {
        screen.style.removeProperty('--reader-max-width');
      }
      screen.style.setProperty('--reader-page-gap', `${Number(gap) || 0}px`);
    }

    const safeBrightness = Math.min(100, Math.max(40, Number(brightness) || 100));
    const safeWarmth = Math.min(50, Math.max(0, Number(warmth) || 0));
    if (content) {
      content.style.filter =
        safeBrightness === 100 && safeWarmth === 0
          ? ''
          : `brightness(${safeBrightness}%) sepia(${safeWarmth}%)`;
    }

    document.querySelectorAll('.reader-chip[data-reader-mode]').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.readerMode === activeMode);
    });

    const effectiveWidth = width || (window.innerWidth >= 768 ? '700px' : '100%');
    document.querySelectorAll('.reader-chip[data-reader-width]').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.readerWidth === effectiveWidth);
    });

    const gapVal = String(Number(gap) || 0);
    document.querySelectorAll('.reader-chip[data-reader-gap]').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.readerGap === gapVal);
    });

    const brightnessSlider = document.getElementById('reader-brightness-slider');
    const brightnessVal = document.getElementById('reader-brightness-val');
    if (brightnessSlider) brightnessSlider.value = String(safeBrightness);
    if (brightnessVal) brightnessVal.textContent = `${safeBrightness}%`;

    const warmthSlider = document.getElementById('reader-warmth-slider');
    const warmthVal = document.getElementById('reader-warmth-val');
    if (warmthSlider) warmthSlider.value = String(safeWarmth);
    if (warmthVal) warmthVal.textContent = `${safeWarmth}%`;

    const wakeToggle = document.getElementById('reader-wakelock-toggle');
    if (wakeToggle) wakeToggle.checked = wakeLock !== false;

    const tapZonesToggle = document.getElementById('reader-tapzones-toggle');
    if (tapZonesToggle) tapZonesToggle.checked = tapZones !== false;
  }

  syncReaderModeView() {
    const content = document.getElementById('reader-content');
    if (!content) return;
    const total = this._readerImages.length || 1;
    const page = Math.max(1, Math.min(this._readerCurrentPage || 1, total));
    const isSingle = this.isSinglePageMode();

    content.querySelectorAll('.reader-page-wrap').forEach((wrap) => {
      wrap.classList.remove('zoomed');
      wrap.scrollLeft = 0;
      wrap.classList.toggle('active-single-page', isSingle && Number(wrap.dataset.page) === page);
    });

    const endNav = document.getElementById('reader-end-nav');
    if (endNav) {
      endNav.classList.toggle('show-in-single', isSingle && page >= total);
    }

    this.updateReaderWindow(page);

    if (isSingle) {
      window.scrollTo(0, 0);
      this.updateReaderProgressBar();
    } else {
      requestAnimationFrame(() => {
        this.jumpToReaderPage(page);
        this.updateReaderProgressBar();
        this.anchorVerticalPage(page);
      });
    }
  }

  async requestWakeLock() {
    if (this.readerSettings?.wakeLock === false) return;
    if (!('wakeLock' in navigator)) return;
    try {
      if (this._wakeLock && !this._wakeLock.released) return;
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener('release', () => {
        if (this._wakeLock && this._wakeLock.released) {
          this._wakeLock = null;
        }
      });
    } catch (e) {
      // Ignore unsupported or disallowed wake lock errors
    }
  }

  async releaseWakeLock() {
    if (this._wakeLock) {
      try {
        await this._wakeLock.release();
      } catch (e) {}
      this._wakeLock = null;
    }
  }

  cleanupReaderTrackers() {
    if (this._readerScrollHandler) {
      window.removeEventListener('scroll', this._readerScrollHandler);
      this._readerScrollHandler = null;
    }
    if (this._readerObserver) {
      this._readerObserver.disconnect();
      this._readerObserver = null;
    }
    if (this._saveProgressTimer) {
      clearTimeout(this._saveProgressTimer);
      this._saveProgressTimer = null;
    }
    if (this._scrubUnlockTimer) {
      clearTimeout(this._scrubUnlockTimer);
      this._scrubUnlockTimer = null;
    }
    this._isScrubbing = false;
    this._isResuming = false;
  }

  clearReaderWindowState() {
    this._readerImages = [];
    for (const url of this._readerPageUrls.values()) {
      if (typeof url === 'string' && url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {}
        this.objectUrlsToRevoke.delete(url);
      }
    }
    this._readerPageUrls.clear();
    this._readerPageHeights.clear();
  }

  updateReaderWindow(centerPage) {
    const content = document.getElementById('reader-content');
    const total = this._readerImages.length;
    if (!content || total === 0) return;

    const center = Math.max(1, Math.min(Number(centerPage) || 1, total));
    const isSingle = this.isSinglePageMode();
    const mountStart = Math.max(1, center - (isSingle ? 2 : 4));
    const mountEnd = Math.min(total, center + (isSingle ? 3 : 6));
    const keepStart = Math.max(1, center - (isSingle ? 3 : 6));
    const keepEnd = Math.min(total, center + (isSingle ? 4 : 8));

    const wraps = content.querySelectorAll('.reader-page-wrap');
    wraps.forEach((wrap) => {
      const pageNum = Number(wrap.dataset.page);
      if (!pageNum) return;
      const existingImg = wrap.querySelector('img');

      if (existingImg && (pageNum < keepStart || pageNum > keepEnd)) {
        const measuredHeight = wrap.offsetHeight || this._readerPageHeights.get(pageNum);
        if (measuredHeight > 0) {
          this._readerPageHeights.set(pageNum, measuredHeight);
          wrap.style.minHeight = `${measuredHeight}px`;
        }
        wrap.innerHTML = '';
        wrap.classList.remove('loaded', 'zoomed');
        wrap.scrollLeft = 0;

        const oldUrl = this._readerPageUrls.get(pageNum);
        if (oldUrl) {
          if (typeof oldUrl === 'string' && oldUrl.startsWith('blob:')) {
            try {
              URL.revokeObjectURL(oldUrl);
            } catch (e) {}
            this.objectUrlsToRevoke.delete(oldUrl);
          }
          this._readerPageUrls.delete(pageNum);
        }
        return;
      }

      if (!existingImg && pageNum >= mountStart && pageNum <= mountEnd) {
        const imgRecord = this._readerImages[pageNum - 1];
        if (!imgRecord) return;

        const savedHeight = this._readerPageHeights.get(pageNum);
        if (savedHeight > 0) {
          wrap.style.minHeight = `${savedHeight}px`;
        }

        const url = this.createManagedUrl(imgRecord.data);
        this._readerPageUrls.set(pageNum, url);

        const imgEl = document.createElement('img');
        imgEl.alt = `Trang ${pageNum}`;
        imgEl.dataset.page = String(pageNum);
        imgEl.decoding = 'async';
        imgEl.loading = 'eager';

        const handleLoaded = () => {
          wrap.classList.add('loaded');
          requestAnimationFrame(() => {
            const h = imgEl.offsetHeight || wrap.offsetHeight;
            if (h > 0) {
              this._readerPageHeights.set(pageNum, h);
            }
            wrap.style.minHeight = '';
          });
        };

        imgEl.addEventListener('load', handleLoaded, { once: true });
        imgEl.addEventListener('error', () => {
          wrap.classList.add('loaded');
          wrap.style.minHeight = '';
        }, { once: true });

        imgEl.src = url;
        wrap.appendChild(imgEl);

        if (imgEl.complete) {
          handleLoaded();
        }
      }
    });
  }

  async saveReadingProgress(immediate = false) {
    if (!this.currentStory) return;

    if (!immediate) {
      if (this._isResuming || this._isScrubbing) return;
      clearTimeout(this._saveProgressTimer);
      this._saveProgressTimer = setTimeout(() => {
        this.saveReadingProgress(true);
      }, 800);
      return;
    }

    clearTimeout(this._saveProgressTimer);
    this._saveProgressTimer = null;

    const story = this.currentStory;
    const total = this._readerImages.length || story.imageCount || 1;
    const page = Math.max(1, Math.min(this._readerCurrentPage || 1, total));
    let ratio = 0;
    if (this.isSinglePageMode()) {
      ratio = total > 1 ? (page - 1) / (total - 1) : 1;
    } else {
      const scrollHeight = document.body.scrollHeight - window.innerHeight;
      ratio = scrollHeight > 0 ? Math.max(0, Math.min(1, window.scrollY / scrollHeight)) : 0;
    }

    if (!story.lastReadPage && page <= 1 && ratio < 0.02) {
      return;
    }

    if (story.lastReadPage === page && Math.abs((story.lastReadRatio || 0) - ratio) < 0.01) {
      return;
    }

    story.lastReadPage = page;
    story.lastReadRatio = Number(ratio.toFixed(4));
    story.lastReadAt = Date.now();

    try {
      await this.db.addStory(story);
    } catch (e) {
      console.warn('Could not save reading progress:', e);
    }
  }

  async togglePageBookmark() {
    if (!this.currentStory) return;
    const total = this._readerImages.length || this.currentStory.imageCount || 1;
    const page = Math.max(1, Math.min(this._readerCurrentPage || 1, total));
    const current = Array.isArray(this.currentStory.bookmarks) ? this.currentStory.bookmarks : [];
    const exists = current.includes(page);

    const updated = exists
      ? current.filter((p) => p !== page)
      : Array.from(new Set([...current, page])).sort((a, b) => a - b);

    this.currentStory.bookmarks = updated;
    this.updateBookmarkUI();

    try {
      await this.db.addStory(this.currentStory);
      this.showToast(exists ? `Đã bỏ đánh dấu trang ${page}` : `Đã đánh dấu trang ${page} ★`, exists ? 'info' : 'success');
    } catch (e) {
      console.warn('Could not save bookmark:', e);
    }
  }

  updateBookmarkUI() {
    const currentPage = this._readerCurrentPage || 1;
    const bookmarks = Array.isArray(this.currentStory?.bookmarks)
      ? Array.from(new Set(this.currentStory.bookmarks)).sort((a, b) => a - b)
      : [];

    const btn = document.getElementById('reader-bookmark-btn');
    if (btn) {
      const isBookmarked = bookmarks.includes(currentPage);
      btn.classList.toggle('bookmarked', isBookmarked);
      btn.textContent = isBookmarked ? '★' : '☆';
      btn.title = isBookmarked ? 'Bỏ đánh dấu trang này' : 'Đánh dấu trang này';
    }

    const listEl = document.getElementById('reader-bookmarks-list');
    if (listEl) {
      if (bookmarks.length === 0) {
        listEl.innerHTML = '<span class="reader-bookmarks-empty">Chưa có trang nào được đánh dấu</span>';
      } else {
        listEl.innerHTML = bookmarks
          .map(
            (p) =>
              `<button type="button" class="reader-bookmark-chip ${p === currentPage ? 'active' : ''}" onclick="app.jumpToBookmarkedPage(${p})">★ Trang ${p}</button>`
          )
          .join('');
      }
    }
  }

  jumpToBookmarkedPage(page) {
    this.goToReaderPage(page);
    this.toggleReaderSettings(false);
  }

  async getOrderedStoryIds() {
    if (Array.isArray(this.currentStoryOrder) && this.currentStoryOrder.length > 0) {
      if (!this.currentStory || this.currentStoryOrder.includes(this.currentStory.id)) {
        return this.currentStoryOrder;
      }
    }
    const allStories = this.sortStoriesList(await this.db.getAllStories());
    this.currentStoryOrder = allStories.map((s) => s.id);
    return this.currentStoryOrder;
  }

  async updateAdjacentStoryButtons() {
    const order = await this.getOrderedStoryIds();
    const idx = this.currentStory ? order.indexOf(this.currentStory.id) : -1;
    const hasPrev = idx > 0;
    const hasNext = idx !== -1 && idx < order.length - 1;

    ['reader-prev-story-btn', 'reader-end-prev-btn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = !hasPrev;
    });
    ['reader-next-story-btn', 'reader-end-next-btn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = !hasNext;
    });
  }

  async openAdjacentStory(delta) {
    const order = await this.getOrderedStoryIds();
    const idx = this.currentStory ? order.indexOf(this.currentStory.id) : -1;
    const targetIdx = idx + delta;
    if (idx === -1 || targetIdx < 0 || targetIdx >= order.length) {
      this.showToast(delta < 0 ? 'Đây là truyện đầu tiên!' : 'Đây là truyện cuối cùng!', 'info');
      return;
    }

    await this.saveReadingProgress(true);
    await this.openStory(order[targetIdx], { replaceHistory: true });
  }

  togglePageZoom(pageWrap, clientX) {
    if (!pageWrap) return;
    const isZoomed = pageWrap.classList.toggle('zoomed');
    if (isZoomed) {
      const rect = pageWrap.getBoundingClientRect();
      const ratioX = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0.5;
      requestAnimationFrame(() => {
        const maxScrollLeft = pageWrap.scrollWidth - pageWrap.clientWidth;
        if (maxScrollLeft > 0) {
          pageWrap.scrollLeft = Math.round(maxScrollLeft * ratioX);
        }
      });
    } else {
      pageWrap.scrollLeft = 0;
    }
  }

  waitForImagesSettled(imgEls, timeoutMs = 600) {
    if (!imgEls || imgEls.length === 0) return Promise.resolve();
    const tasks = imgEls.map(
      (img) =>
        new Promise((resolve) => {
          const finish = () => {
            img.parentElement?.classList.add('loaded');
            if (typeof img.decode === 'function') {
              img.decode().catch(() => {}).finally(resolve);
            } else {
              resolve();
            }
          };
          if (img.complete) {
            finish();
          } else {
            img.addEventListener('load', finish, { once: true });
            img.addEventListener('error', finish, { once: true });
          }
        })
    );
    return Promise.race([
      Promise.all(tasks),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async anchorVerticalPage(page) {
    const content = document.getElementById('reader-content');
    if (!content) return;
    const sessionId = this._readerSessionId;
    const nearImgs = [];
    for (let p = Math.max(1, page - 2); p <= Math.min(this._readerImages.length, page + 1); p++) {
      const imgEl = content.querySelector(`.reader-page-wrap[data-page="${p}"] img`);
      if (imgEl) nearImgs.push(imgEl);
    }
    await this.waitForImagesSettled(nearImgs, 350);
    if (this._readerSessionId !== sessionId || this.isSinglePageMode() || this._isScrubbing) return;
    const wrap = content.querySelector(`.reader-page-wrap[data-page="${page}"]`);
    if (wrap) {
      wrap.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
    this.updateReaderProgressBar();
  }

  jumpToReaderPage(page) {
    const content = document.getElementById('reader-content');
    if (!content) return;
    this.updateReaderWindow(page);
    const wrap = content.querySelector(`.reader-page-wrap[data-page="${page}"]`);
    if (wrap) {
      wrap.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }

  goToReaderPage(page) {
    const total = this._readerImages.length || 1;
    const targetPage = Math.max(1, Math.min(Number(page) || 1, total));
    this._readerCurrentPage = targetPage;

    const currentEl = document.getElementById('reader-current');
    if (currentEl) currentEl.textContent = String(targetPage);
    const scrubber = document.getElementById('reader-scrubber');
    if (scrubber) scrubber.value = String(targetPage);

    const content = document.getElementById('reader-content');
    if (this.isSinglePageMode()) {
      if (content) {
        content.querySelectorAll('.reader-page-wrap').forEach((wrap) => {
          const isTarget = Number(wrap.dataset.page) === targetPage;
          wrap.classList.toggle('active-single-page', isTarget);
          wrap.classList.remove('zoomed');
          wrap.scrollLeft = 0;
        });
      }
      const endNav = document.getElementById('reader-end-nav');
      if (endNav) {
        endNav.classList.toggle('show-in-single', targetPage >= total);
      }
      window.scrollTo(0, 0);
      this.updateReaderWindow(targetPage);
      this.updateReaderProgressBar();
      this.updateBookmarkUI();
      this.saveReadingProgress(false);
    } else {
      this.updateReaderWindow(targetPage);
      this.jumpToReaderPage(targetPage);
      this.updateBookmarkUI();
      if (!this._isScrubbing) {
        this.anchorVerticalPage(targetPage);
      }
    }
  }

  stepReaderPage(delta) {
    const total = this._readerImages.length || 1;
    const next = (this._readerCurrentPage || 1) + delta;
    if (next < 1) {
      this.showToast('Đang ở trang đầu tiên!', 'info');
      return;
    }
    if (next > total) {
      this.showToast('Đã đến trang cuối!', 'info');
      return;
    }
    this.goToReaderPage(next);
  }

  updateReaderProgressBar() {
    const progressBar = document.getElementById('reader-progress');
    if (!progressBar) return;
    if (this.isSinglePageMode()) {
      const total = this._readerImages.length || 1;
      const page = Math.max(1, Math.min(this._readerCurrentPage || 1, total));
      progressBar.style.width = `${(page / total) * 100}%`;
      return;
    }
    const scrollTop = window.scrollY;
    const scrollHeight = document.body.scrollHeight - window.innerHeight;
    const progress = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
    progressBar.style.width = `${Math.max(0, Math.min(progress, 100))}%`;
  }

  async openStory(storyId, options = {}) {
    const story = await this.db.getStory(storyId);
    if (!story) return;

    const images = await this.db.getImagesByStory(storyId);
    if (images.length === 0) {
      this.showToast('Truyện chưa có ảnh!', 'error');
      return;
    }

    const sessionId = ++this._readerSessionId;
    this._isExitingReader = false;
    this._allowPopstateExit = false;

    // Remember library scroll position (only when entering from library) and current story ID
    const readerScreen = document.getElementById('screen-reader');
    if (!readerScreen?.classList.contains('active')) {
      this.lastLibraryScrollY = window.scrollY;
    }
    this.lastViewedStoryId = storyId;

    // Push or replace history state so mobile back gesture/button returns to library naturally
    if (options.replaceHistory || history.state?.screen === 'reader') {
      history.replaceState({ screen: 'reader', storyId }, '');
    } else {
      history.pushState({ screen: 'reader', storyId }, '');
    }

    this.cleanupReaderTrackers();
    this.clearReaderWindowState();
    this.revokeManagedUrls();
    this.currentStory = story;
    this._readerImages = images;
    this.readerUIVisible = true;

    const resumePage =
      story.lastReadPage > 1 && story.lastReadPage <= images.length ? story.lastReadPage : 1;
    this._readerCurrentPage = resumePage;
    this._isResuming = resumePage > 1;

    // Set header & scrubber
    document.getElementById('reader-title').textContent = story.name;
    document.getElementById('reader-total').textContent = images.length;
    document.getElementById('reader-current').textContent = String(resumePage);
    const scrubber = document.getElementById('reader-scrubber');
    if (scrubber) {
      scrubber.min = '1';
      scrubber.max = String(images.length);
      scrubber.value = String(resumePage);
    }

    // Render lightweight empty shells; ObjectURLs & <img> are mounted lazily by updateReaderWindow()
    const content = document.getElementById('reader-content');
    const isSingle = this.isSinglePageMode();
    const pagesHtml = images
      .map((_, idx) => {
        const pageNum = idx + 1;
        const activeClass = isSingle && pageNum === resumePage ? ' active-single-page' : '';
        return `<div class="reader-page-wrap${activeClass}" data-page="${pageNum}"></div>`;
      })
      .join('');

    const endNavShowClass = isSingle && resumePage >= images.length ? ' show-in-single' : '';
    const endNavHtml = `
      <div class="reader-end-nav${endNavShowClass}" id="reader-end-nav">
        <div class="reader-end-title">Hết truyện "${this.escapeHTML(story.name)}"</div>
        <div class="reader-end-actions">
          <button type="button" class="btn btn-secondary" id="reader-end-prev-btn" onclick="app.openAdjacentStory(-1)">⏮ Truyện trước</button>
          <button type="button" class="btn btn-primary" id="reader-end-next-btn" onclick="app.openAdjacentStory(1)">Truyện tiếp theo ⏭</button>
          <button type="button" class="btn btn-secondary" onclick="app.exitReader()">📚 Về thư viện</button>
        </div>
      </div>
    `;

    content.innerHTML = pagesHtml + endNavHtml;

    // Apply saved reader settings & show reader
    this.applyReaderSettings();
    this.showScreen('reader');
    this.updateBookmarkUI();

    // Update reader header/footer visibility & reset settings panel
    document.getElementById('reader-header').classList.remove('hidden');
    document.getElementById('reader-footer').classList.remove('hidden');
    this.toggleReaderSettings(false);

    // Mount active window around resumePage, setup scroll tracking, adjacent buttons & wake lock
    this.updateReaderWindow(resumePage);
    this.setupReaderScroll(images.length);
    this.updateAdjacentStoryButtons();
    this.requestWakeLock();

    // Resume exact reading position if previously read past page 1
    if (resumePage > 1) {
      this.showToast(`Tiếp tục từ trang ${resumePage} / ${images.length}`, 'info');
      if (isSingle) {
        window.scrollTo(0, 0);
        this._isResuming = false;
        this.updateReaderProgressBar();
      } else {
        const target = content.querySelector(`.reader-page-wrap[data-page="${resumePage}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'auto', block: 'start' });
        }

        const eagerImgs = [];
        for (let p = Math.max(1, resumePage - 2); p <= Math.min(images.length, resumePage + 2); p++) {
          const imgEl = content.querySelector(`.reader-page-wrap[data-page="${p}"] img`);
          if (imgEl) eagerImgs.push(imgEl);
        }

        await this.waitForImagesSettled(eagerImgs, 600);
        if (this._readerSessionId !== sessionId) return;

        if (target) {
          target.scrollIntoView({ behavior: 'auto', block: 'start' });
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (this._readerSessionId !== sessionId) return;

        if (target) {
          target.scrollIntoView({ behavior: 'auto', block: 'start' });
        }
        this._isResuming = false;
        this.updateReaderProgressBar();
      }
    }
  }

  setupReaderScroll(totalPages) {
    const wasResuming = this._isResuming;
    this.cleanupReaderTrackers();
    this._isResuming = wasResuming;

    const content = document.getElementById('reader-content');
    const currentEl = document.getElementById('reader-current');
    const scrubber = document.getElementById('reader-scrubber');

    if (scrubber) {
      scrubber.min = '1';
      scrubber.max = String(Math.max(1, totalPages));
      scrubber.value = String(this._readerCurrentPage || 1);
    }

    if ('IntersectionObserver' in window) {
      this._readerObserver = new IntersectionObserver(
        (entries) => {
          if (this._isScrubbing || this._isResuming || this.isSinglePageMode()) return;
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const page = Number(entry.target.dataset.page);
              if (page && page !== this._readerCurrentPage) {
                this._readerCurrentPage = page;
                if (currentEl) currentEl.textContent = String(page);
                if (scrubber) scrubber.value = String(page);
                this.updateBookmarkUI();
                this.updateReaderWindow(page);
              }
            }
          }
        },
        { rootMargin: '-45% 0px -45% 0px', threshold: 0 }
      );

      content.querySelectorAll('.reader-page-wrap').forEach((wrap) => {
        this._readerObserver.observe(wrap);
      });
    }

    let ticking = false;
    const scrollHandler = () => {
      if (this.isSinglePageMode()) return;
      if (!ticking) {
        requestAnimationFrame(() => {
          this.updateReaderProgressBar();
          if (!this._isResuming && !this._isScrubbing) {
            this.saveReadingProgress(false);
          }
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', scrollHandler, { passive: true });
    this._readerScrollHandler = scrollHandler;
    if (!this._isResuming) {
      this.updateReaderProgressBar();
    }
  }

  toggleReaderUI(forceVisible) {
    this.readerUIVisible = typeof forceVisible === 'boolean' ? forceVisible : !this.readerUIVisible;
    const header = document.getElementById('reader-header');
    const footer = document.getElementById('reader-footer');

    if (this.readerUIVisible) {
      header.classList.remove('hidden');
      footer.classList.remove('hidden');
    } else {
      header.classList.add('hidden');
      footer.classList.add('hidden');
      this.toggleReaderSettings(false);
    }
  }

  async exitReader(triggerHistoryBack = true) {
    if (this._isExitingReader && !this._allowPopstateExit) return;
    this._isExitingReader = true;
    this._allowPopstateExit = false;

    try {
      await this.saveReadingProgress(true);

      if (triggerHistoryBack && history.state && history.state.screen === 'reader') {
        this._allowPopstateExit = true;
        history.back();
        return;
      }

      this._readerSessionId++;
      this.cleanupReaderTrackers();
      this.clearReaderWindowState();
      clearTimeout(this._singleTapTimer);
      this._singleTapTimer = null;
      this.toggleReaderSettings(false);
      this.releaseWakeLock();
      this.revokeManagedUrls();
      this.currentStory = null;

      const content = document.getElementById('reader-content');
      if (content) content.innerHTML = '';

      // Return to library while preserving scroll
      this.showScreen('library', true);
      await this.loadLibrary();

      if (this.lastViewedStoryId) {
        const targetId = this.lastViewedStoryId;
        setTimeout(() => {
          const card = document.querySelector(`.story-card[data-id="${targetId}"]`);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('story-card-highlight');
            setTimeout(() => card.classList.remove('story-card-highlight'), 1800);
          } else if (this.lastLibraryScrollY != null) {
            window.scrollTo({ top: this.lastLibraryScrollY, behavior: 'smooth' });
          }
        }, 80);
        this.lastViewedStoryId = null;
      } else if (this.lastLibraryScrollY != null) {
        window.scrollTo(0, this.lastLibraryScrollY);
      }
    } finally {
      if (!this._allowPopstateExit) {
        this._isExitingReader = false;
      }
    }
  }

  // ==================== STORY MENU ====================
  showStoryMenu(storyId) {
    this.currentMenuStoryId = storyId;
    this.db.getStory(storyId).then((story) => {
      document.getElementById('modal-story-name').textContent = story.name;
      document.getElementById('modal-overlay').style.display = 'flex';
    });
  }

  closeModal() {
    document.getElementById('modal-overlay').style.display = 'none';
    this.currentMenuStoryId = null;
  }

  menuRead() {
    const id = this.currentMenuStoryId;
    this.closeModal();
    this.openStory(id);
  }

  menuEdit() {
    const id = this.currentMenuStoryId;
    this.closeModal();
    this.openEdit(id);
  }

  menuDelete() {
    const id = this.currentMenuStoryId;
    if (confirm('Bạn có chắc muốn xoá truyện này?')) {
      this.deleteStory(id);
    }
  }

  // ==================== CATEGORY MANAGEMENT ====================
  selectCategory(catId) {
    this.selectedCategoryId = catId;
    this.loadLibrary();
  }

  editCurrentCategory() {
    if (this.selectedCategoryId !== 'all') {
      this.openCategoryModal(this.selectedCategoryId);
    }
  }

  async deleteCurrentCategoryPrompt() {
    if (this.selectedCategoryId !== 'all') {
      this.deleteCategory(this.selectedCategoryId);
    }
  }

  async openCategoryModal(catId = null) {
    this.currentCategoryEditId = catId;
    this.categorySelectedStoryIds.clear();

    const allStories = await this.db.getAllStories();
    allStories.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

    const nameInput = document.getElementById('category-name-input');
    const titleEl = document.getElementById('category-modal-title');
    const deleteBtn = document.getElementById('category-modal-delete-btn');

    if (catId) {
      const cat = this.categories.find((c) => c.id === catId);
      if (!cat) return;
      if (titleEl) titleEl.textContent = 'Chỉnh sửa danh mục';
      if (nameInput) nameInput.value = cat.name;
      (cat.storyIds || []).forEach((id) => this.categorySelectedStoryIds.add(id));
      if (deleteBtn) deleteBtn.style.display = 'block';
    } else {
      if (titleEl) titleEl.textContent = 'Tạo danh mục mới';
      if (nameInput) nameInput.value = '';
      if (deleteBtn) deleteBtn.style.display = 'none';
    }

    this.renderCategoryStoriesList(allStories);
    this.updateCategorySelectCount();

    const modal = document.getElementById('category-modal-overlay');
    if (modal) modal.style.display = 'flex';
  }

  renderCategoryStoriesList(allStories) {
    const list = document.getElementById('category-stories-list');
    if (!list) return;

    if (allStories.length === 0) {
      list.innerHTML = `
        <div style="text-align: center; padding: 25px 10px; color: var(--text-muted); font-size: 0.85rem;">
          Chưa có truyện nào trong thư viện để thêm.
        </div>
      `;
      return;
    }

    list.innerHTML = allStories
      .map((story) => {
        const isSelected = this.categorySelectedStoryIds.has(story.id);
        return `
          <div class="story-select-item ${isSelected ? 'selected' : ''}" data-id="${story.id}" onclick="app.toggleStorySelectionForCategory('${story.id}')">
            ${
              story.coverData
                ? `<img class="story-select-thumb" src="${story.coverData}" alt="${story.name}">`
                : `<div class="story-select-thumb-placeholder">📖</div>`
            }
            <div class="story-select-info">
              <div class="story-select-name">${this.escapeHTML(story.name)}</div>
              <div class="story-select-meta">🖼️ ${story.imageCount || 0} ảnh</div>
            </div>
            <div class="custom-checkbox">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
          </div>
        `;
      })
      .join('');
  }

  toggleStorySelectionForCategory(storyId) {
    if (this.categorySelectedStoryIds.has(storyId)) {
      this.categorySelectedStoryIds.delete(storyId);
    } else {
      this.categorySelectedStoryIds.add(storyId);
    }

    const item = document.querySelector(`.story-select-item[data-id="${storyId}"]`);
    if (item) {
      if (this.categorySelectedStoryIds.has(storyId)) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    }
    this.updateCategorySelectCount();
  }

  async selectAllStoriesForCategory(selectAll) {
    const allStories = await this.db.getAllStories();
    if (selectAll) {
      allStories.forEach((s) => this.categorySelectedStoryIds.add(s.id));
    } else {
      this.categorySelectedStoryIds.clear();
    }
    this.renderCategoryStoriesList(allStories);
    this.updateCategorySelectCount();
  }

  updateCategorySelectCount() {
    const countEl = document.getElementById('category-select-count');
    if (countEl) {
      countEl.textContent = `Đã chọn: ${this.categorySelectedStoryIds.size} truyện`;
    }
  }

  closeCategoryModal() {
    const modal = document.getElementById('category-modal-overlay');
    if (modal) modal.style.display = 'none';
    this.currentCategoryEditId = null;
  }

  async saveCategory() {
    const nameInput = document.getElementById('category-name-input');
    const name = nameInput ? nameInput.value.trim() : '';

    if (!name) {
      this.showToast('Vui lòng nhập tên danh mục!', 'error');
      if (nameInput) nameInput.focus();
      return;
    }

    const storyIds = Array.from(this.categorySelectedStoryIds);
    let cat;

    if (this.currentCategoryEditId) {
      const existing = this.categories.find((c) => c.id === this.currentCategoryEditId);
      cat = {
        ...(existing || {}),
        id: this.currentCategoryEditId,
        name: name,
        storyIds: storyIds,
        updatedAt: Date.now(),
      };
    } else {
      cat = {
        id: 'cat_' + this.generateId(),
        name: name,
        storyIds: storyIds,
        createdAt: Date.now(),
      };
    }

    await this.db.addCategory(cat);
    this.selectedCategoryId = cat.id;
    this.closeCategoryModal();
    await this.loadLibrary();
    this.showToast(this.currentCategoryEditId ? 'Đã cập nhật danh mục ✓' : 'Đã tạo danh mục mới ✓', 'success');
  }

  deleteCategoryFromModal() {
    if (this.currentCategoryEditId) {
      this.deleteCategory(this.currentCategoryEditId);
    }
  }

  async deleteCategory(catId) {
    const cat = this.categories.find((c) => c.id === catId);
    const catName = cat ? cat.name : 'danh mục này';

    if (!confirm(`Bạn có chắc muốn xoá danh mục "${catName}"?\n(Các truyện bên trong sẽ KHÔNG bị ảnh hưởng)`)) {
      return;
    }

    await this.db.deleteCategory(catId);
    if (this.selectedCategoryId === catId) {
      this.selectedCategoryId = 'all';
    }
    this.closeCategoryModal();
    await this.loadLibrary();
    this.showToast('Đã xoá danh mục ✓', 'success');
  }

  // ==================== STORY CATEGORY ASSIGN ====================
  async openStoryCategoryModal() {
    const storyId = this.currentMenuStoryId;
    if (!storyId) return;

    this.closeModal(); // Close main story context menu

    const story = await this.db.getStory(storyId);
    if (!story) return;

    this.categories = await this.db.getAllCategories();
    this.storyAssignCategoryIds.clear();

    for (const cat of this.categories) {
      if (cat.storyIds && cat.storyIds.includes(storyId)) {
        this.storyAssignCategoryIds.add(cat.id);
      }
    }

    const titleEl = document.getElementById('story-category-modal-title');
    if (titleEl) titleEl.textContent = `Phân loại: ${story.name}`;

    const list = document.getElementById('story-category-list');
    if (list) {
      if (this.categories.length === 0) {
        list.innerHTML = `
          <div style="text-align: center; padding: 24px 10px; color: var(--text-muted); font-size: 0.85rem;">
            Chưa có danh mục nào.<br><br>
            <button class="btn btn-primary" style="margin: 0 auto; padding: 8px 16px; font-size: 0.8rem;" onclick="app.closeStoryCategoryModal(); app.openCategoryModal();">
              ➕ Tạo danh mục mới
            </button>
          </div>
        `;
      } else {
        list.innerHTML = this.categories
          .map((cat) => {
            const isSelected = this.storyAssignCategoryIds.has(cat.id);
            return `
              <div class="category-checkbox-item ${isSelected ? 'selected' : ''}" data-id="${cat.id}" onclick="app.toggleStoryCategoryAssign('${cat.id}')">
                <span style="font-size: 1.25rem;">📁</span>
                <div style="flex: 1; min-width: 0;">
                  <div style="font-size: 0.88rem; font-weight: 600; color: var(--text-primary);">${this.escapeHTML(cat.name)}</div>
                  <div style="font-size: 0.72rem; color: var(--text-muted);">${(cat.storyIds || []).length} truyện</div>
                </div>
                <div class="custom-checkbox">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
              </div>
            `;
          })
          .join('');
      }
    }

    const modal = document.getElementById('story-category-modal-overlay');
    if (modal) modal.style.display = 'flex';
  }

  toggleStoryCategoryAssign(catId) {
    if (this.storyAssignCategoryIds.has(catId)) {
      this.storyAssignCategoryIds.delete(catId);
    } else {
      this.storyAssignCategoryIds.add(catId);
    }

    const item = document.querySelector(`.category-checkbox-item[data-id="${catId}"]`);
    if (item) {
      if (this.storyAssignCategoryIds.has(catId)) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    }
  }

  async saveStoryCategories() {
    const storyId = this.currentMenuStoryId;
    if (!storyId) {
      this.closeStoryCategoryModal();
      return;
    }

    for (const cat of this.categories) {
      cat.storyIds = cat.storyIds || [];
      const hasStory = cat.storyIds.includes(storyId);
      const shouldHave = this.storyAssignCategoryIds.has(cat.id);

      if (shouldHave && !hasStory) {
        cat.storyIds.push(storyId);
        await this.db.addCategory(cat);
      } else if (!shouldHave && hasStory) {
        cat.storyIds = cat.storyIds.filter((id) => id !== storyId);
        await this.db.addCategory(cat);
      }
    }

    this.closeStoryCategoryModal();
    await this.loadLibrary();
    this.showToast('Đã cập nhật danh mục cho truyện ✓', 'success');
  }

  closeStoryCategoryModal() {
    const modal = document.getElementById('story-category-modal-overlay');
    if (modal) modal.style.display = 'none';
  }

  // ==================== BACKUP & RESTORE ====================
  async openBackupModal() {
    const modal = document.getElementById('backup-modal-overlay');
    if (modal) modal.style.display = 'flex';
    this.hideBackupProgress();
    await this.updateStorageUI();
    this.initGDriveUI();
  }

  closeBackupModal() {
    const modal = document.getElementById('backup-modal-overlay');
    if (modal) modal.style.display = 'none';
    this.hideBackupProgress();
  }

  showBackupProgress(text, percent = 0) {
    const card = document.getElementById('backup-progress-card');
    const textEl = document.getElementById('backup-status-text');
    const fillEl = document.getElementById('backup-progress-fill');
    if (card) card.style.display = 'flex';
    if (textEl) textEl.textContent = text;
    if (fillEl) fillEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }

  hideBackupProgress() {
    const card = document.getElementById('backup-progress-card');
    const textEl = document.getElementById('backup-status-text');
    const fillEl = document.getElementById('backup-progress-fill');
    if (card) card.style.display = 'none';
    if (textEl) textEl.textContent = 'Đang xử lý dữ liệu...';
    if (fillEl) fillEl.style.width = '0%';
  }

  // --- Google Drive Cloud Sync Helpers ---
  initGDriveUI() {
    const clientInput = document.getElementById('gdrive-client-id-input');
    const folderInput = document.getElementById('gdrive-folder-name-input');
    if (clientInput) clientInput.value = this.gdriveClientId || '';
    if (folderInput) folderInput.value = this.gdriveFolderName || 'KhoTruyen';
    this.updateGDriveBadge(Boolean(this.gdriveAccessToken && this.gdriveTokenExpiresAt > Date.now() + 60000));
  }

  saveGDriveSettings() {
    const clientInput = document.getElementById('gdrive-client-id-input');
    const folderInput = document.getElementById('gdrive-folder-name-input');
    if (clientInput) {
      this.gdriveClientId = clientInput.value.trim();
      localStorage.setItem('khotruyen_gdrive_client_id', this.gdriveClientId);
    }
    if (folderInput) {
      this.gdriveFolderName = folderInput.value.trim() || 'KhoTruyen';
      localStorage.setItem('khotruyen_gdrive_folder_name', this.gdriveFolderName);
    }
    this.updateGDriveBadge(Boolean(this.gdriveAccessToken && this.gdriveTokenExpiresAt > Date.now() + 60000));
    this.showToast('Đã lưu cấu hình Google Drive ✓', 'success');
  }

  toggleGDriveGuide() {
    const guide = document.getElementById('gdrive-guide-content');
    if (guide) {
      guide.style.display = guide.style.display === 'none' ? 'block' : 'none';
    }
  }

  updateGDriveBadge(isConnected) {
    const badge = document.getElementById('gdrive-status-badge');
    if (!badge) return;
    if (isConnected) {
      badge.textContent = '✓ Đã kết nối';
      badge.className = 'gdrive-status-badge connected';
    } else if (this.gdriveClientId) {
      badge.textContent = 'Sẵn sàng đăng nhập';
      badge.className = 'gdrive-status-badge';
    } else {
      badge.textContent = 'Chưa cấu hình';
      badge.className = 'gdrive-status-badge';
    }
  }

  initGoogleAuth() {
    return new Promise((resolve, reject) => {
      const clientId = (this.gdriveClientId || localStorage.getItem('khotruyen_gdrive_client_id') || '').trim();
      if (!clientId) {
        return reject(new Error('Vui lòng nhập Google Client ID trong phần cài đặt sao lưu Google Drive!'));
      }

      if (this.gdriveAccessToken && this.gdriveTokenExpiresAt > Date.now() + 60000) {
        return resolve(this.gdriveAccessToken);
      }

      const proceedAuth = () => {
        try {
          if (!window.google?.accounts?.oauth2) {
            return reject(new Error('Không tìm thấy thư viện Google Identity Services.'));
          }
          let settled = false;
          const finishResolve = (val) => {
            if (settled) return;
            settled = true;
            resolve(val);
          };
          const finishReject = (err) => {
            if (settled) return;
            settled = true;
            reject(err);
          };

          const tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/drive.file',
            callback: (tokenResponse) => {
              if (tokenResponse && tokenResponse.access_token) {
                this.gdriveAccessToken = tokenResponse.access_token;
                const expiresIn = Number(tokenResponse.expires_in) || 3600;
                this.gdriveTokenExpiresAt = Date.now() + expiresIn * 1000;
                this.updateGDriveBadge(true);
                finishResolve(tokenResponse.access_token);
              } else if (tokenResponse && tokenResponse.error) {
                finishReject(new Error('Lỗi xác thực Google: ' + (tokenResponse.error_description || tokenResponse.error)));
              } else {
                finishReject(new Error('Đăng nhập Google bị hủy hoặc thất bại!'));
              }
            },
            error_callback: (err) => {
              const type = err?.type || '';
              if (type === 'popup_closed') {
                finishReject(new Error('Bạn đã đóng cửa sổ đăng nhập Google.'));
              } else if (type === 'popup_failed_to_open') {
                finishReject(new Error('Trình duyệt đã chặn popup đăng nhập Google. Vui lòng cho phép popup và thử lại!'));
              } else {
                finishReject(new Error('Lỗi xác thực Google: ' + (err?.message || type || 'Không xác định')));
              }
            },
          });
          tokenClient.requestAccessToken({ prompt: '' });
        } catch (e) {
          reject(e);
        }
      };

      if (!window.google?.accounts?.oauth2) {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => proceedAuth();
        script.onerror = () => reject(new Error('Không thể tải thư viện Google Identity Services. Hãy kiểm tra kết nối mạng!'));
        document.head.appendChild(script);
      } else {
        proceedAuth();
      }
    });
  }

  async getOrCreateGDriveFolder(folderName, token) {
    if (!folderName || folderName.trim() === '') return null;
    const cleanName = folderName.trim();
    try {
      const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${cleanName.replace(/'/g, "\\'")}' and trashed = false`;
      const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        if (searchData.files && searchData.files.length > 0) {
          return searchData.files[0].id;
        }
      }

      // Create folder
      const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: cleanName,
          mimeType: 'application/vnd.google-apps.folder',
        }),
      });
      if (createRes.ok) {
        const createData = await createRes.json();
        return createData.id;
      }
    } catch (e) {
      console.warn('Folder resolution error:', e);
    }
    return null;
  }

  // --- Shared Backup Data Generator ---
  async generateBackupData(contentMode = 'full', onProgress) {
    const stories = await this.db.getAllStories();
    const categories = await this.db.getAllCategories();

    if (stories.length === 0 && categories.length === 0) {
      this.showToast('Kho truyện đang trống, không có gì để sao lưu!', 'error');
      this.hideBackupProgress();
      return null;
    }

    const allImages = [];
    if (contentMode === 'full') {
      let totalImgCount = 0;
      for (const s of stories) {
        totalImgCount += s.imageCount || 0;
      }

      let processedImgs = 0;
      for (const s of stories) {
        const imgs = await this.db.getImagesByStory(s.id);
        for (const img of imgs) {
          let dataUrl = '';
          if (img.data instanceof Blob) {
            dataUrl = await this.blobToDataUrl(img.data);
          } else {
            dataUrl = img.data;
          }

          allImages.push({
            id: img.id,
            storyId: img.storyId,
            name: img.name,
            data: dataUrl,
            order: img.order,
          });

          processedImgs++;
          if (onProgress && (processedImgs % 5 === 0 || processedImgs === totalImgCount)) {
            const pct = Math.round((processedImgs / Math.max(1, totalImgCount)) * 100);
            onProgress(`Đang xuất ảnh: ${processedImgs} / ${totalImgCount}...`, pct);
          }
        }
      }
    }

    return {
      app: 'KhoTruyen',
      version: 2,
      mode: contentMode,
      exportedAt: Date.now(),
      stories: stories,
      categories: categories,
      images: allImages,
    };
  }

  toggleRestoreModeUI() {
    const isMerge = document.getElementById('restore-mode-merge')?.checked;
    const skipContainer = document.getElementById('restore-skip-duplicates-container');
    if (skipContainer) {
      skipContainer.style.display = isMerge ? 'flex' : 'none';
    }
  }

  // --- Shared Backup Data Applier / Restorer ---
  async applyBackupData(data, mode = 'merge') {
    if (!data || data.app !== 'KhoTruyen' || !Array.isArray(data.stories)) {
      throw new Error('Dữ liệu không hợp lệ hoặc không phải bản sao lưu của Kho Truyện!');
    }

    if (mode === 'replace') {
      if (!confirm('Chế độ "Thay thế toàn bộ" sẽ xoá toàn bộ kho truyện hiện tại trước khi nạp dữ liệu mới. Bạn có chắc chắn không?')) {
        this.hideBackupProgress();
        return;
      }
      this.showBackupProgress('Đang xoá dữ liệu cũ...', 25);
      await this.db.clearAllData();
    }

    const skipDuplicates = document.getElementById('restore-skip-duplicates')?.checked ?? true;
    let storiesToRestore = data.stories;
    let duplicateCount = 0;
    const skippedStoryIds = new Set();

    if (mode === 'merge' && skipDuplicates) {
      this.showBackupProgress('Đang quét truyện trùng lặp với kho...', 28);
      const existingStories = await this.db.getAllStories();
      const existingIds = new Set(existingStories.map((s) => s.id));
      const existingHitomiIds = new Set(existingStories.map((s) => String(s.hitomiGalleryId || '')).filter(Boolean));
      const existingNames = new Set(existingStories.map((s) => s.name?.trim().toLowerCase()).filter(Boolean));

      storiesToRestore = [];
      for (const story of data.stories) {
        const isDup =
          existingIds.has(story.id) ||
          (story.hitomiGalleryId && existingHitomiIds.has(String(story.hitomiGalleryId))) ||
          (story.name && existingNames.has(story.name.trim().toLowerCase()));

        if (isDup) {
          duplicateCount++;
          skippedStoryIds.add(story.id);
        } else {
          storiesToRestore.push(story);
        }
      }
    }

    // Restore categories (merge categories if merge mode)
    this.showBackupProgress('Đang khôi phục danh mục...', 35);
    if (Array.isArray(data.categories)) {
      const existingCats = await this.db.getAllCategories();
      const existingCatMap = new Map(existingCats.map((c) => [c.name.toLowerCase(), c]));

      for (const cat of data.categories) {
        const existingCat = existingCatMap.get(cat.name.toLowerCase());
        if (existingCat) {
          existingCat.storyIds = Array.from(new Set([...(existingCat.storyIds || []), ...(cat.storyIds || [])]));
          await this.db.addCategory(existingCat);
        } else {
          await this.db.addCategory(cat);
        }
      }
    }

    // Restore stories (only non-duplicates)
    this.showBackupProgress('Đang khôi phục danh sách truyện...', 50);
    for (const story of storiesToRestore) {
      await this.db.addStory(story);
    }

    // Restore images (stored as Blobs, skipping images of duplicate stories)
    const allImages = Array.isArray(data.images) ? data.images : [];
    const imagesToRestore = allImages.filter((img) => !skippedStoryIds.has(img.storyId));
    let restoredImgs = 0;
    const totalImgs = imagesToRestore.length;

    for (const img of imagesToRestore) {
      let blobData = null;
      if (typeof img.data === 'string' && img.data.startsWith('data:')) {
        blobData = await this.dataUrlToBlob(img.data);
      } else if (img.data instanceof Blob) {
        blobData = img.data;
      }

      await this.db.addImage({
        id: img.id || this.generateId(),
        storyId: img.storyId,
        name: img.name,
        data: blobData || img.data,
        order: img.order || 0,
      });

      restoredImgs++;
      if (restoredImgs % 5 === 0 || restoredImgs === totalImgs) {
        const percent = Math.round(50 + (restoredImgs / Math.max(1, totalImgs)) * 48);
        this.showBackupProgress(`Đang nạp ảnh: ${restoredImgs} / ${totalImgs}...`, percent);
      }
    }

    this.showBackupProgress('Khôi phục hoàn tất!', 100);
    await this.loadLibrary();
    await this.updateStorageUI();

    if (duplicateCount > 0) {
      if (storiesToRestore.length === 0) {
        this.showToast(`Tất cả ${duplicateCount} bộ truyện trong bản sao lưu đã có sẵn trong kho!`, 'info');
      } else {
        this.showToast(`Khôi phục thành công ${storiesToRestore.length} bộ truyện mới (đã bỏ qua ${duplicateCount} bộ trùng lặp) ✓`, 'success');
      }
    } else {
      this.showToast(`Khôi phục thành công ${storiesToRestore.length} truyện ✓`, 'success');
    }

    setTimeout(() => {
      this.closeBackupModal();
    }, 1200);
  }

  // --- Export to Device (.json) ---
  async exportBackup() {
    try {
      this.showBackupProgress('Đang đọc danh sách truyện & danh mục...', 5);
      const backupData = await this.generateBackupData('full', (msg, pct) => {
        this.showBackupProgress(msg, Math.round(10 + pct * 0.75));
      });

      if (!backupData) return;

      this.showBackupProgress('Đang tạo file sao lưu...', 90);
      const jsonStr = JSON.stringify(backupData);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      const timeStr = now.toTimeString().slice(0, 5).replace(/:/g, '');
      const filename = `KhoTruyen_Backup_${dateStr}_${timeStr}.json`;

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.showBackupProgress('Đã xuất bản sao lưu thành công!', 100);
      this.showToast('Đã tải file sao lưu về máy ✓', 'success');

      setTimeout(() => {
        this.closeBackupModal();
      }, 1200);
    } catch (err) {
      console.error('Backup error:', err);
      this.showToast('Lỗi khi xuất sao lưu: ' + err.message, 'error');
      this.hideBackupProgress();
    }
  }

  // --- Import from Device (.json) ---
  async importBackup(file) {
    if (!file) return;
    const mode = document.querySelector('input[name="restore-mode"]:checked')?.value || 'merge';

    try {
      this.showBackupProgress('Đang đọc file sao lưu...', 10);
      const text = await file.text();

      this.showBackupProgress('Đang giải mã dữ liệu...', 20);
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('File JSON bị lỗi định dạng!');
      }

      await this.applyBackupData(data, mode);
    } catch (err) {
      console.error('Restore error:', err);
      this.showToast('Lỗi khôi phục: ' + err.message, 'error');
      this.hideBackupProgress();
    }
  }

  // --- Upload directly to Google Drive ---
  async uploadToGoogleDrive() {
    try {
      const clientId = (this.gdriveClientId || localStorage.getItem('khotruyen_gdrive_client_id') || '').trim();
      if (!clientId) {
        this.showToast('Vui lòng nhập Google Client ID trước!', 'info');
        const input = document.getElementById('gdrive-client-id-input');
        if (input) input.focus();
        return;
      }

      const filenameMode = document.querySelector('input[name="gdrive-filename-mode"]:checked')?.value || 'overwrite';
      const contentMode = document.querySelector('input[name="gdrive-content-mode"]:checked')?.value || 'full';
      const folderName = (this.gdriveFolderName || 'KhoTruyen').trim();

      this.showBackupProgress('Đang kết nối Google Drive...', 5);
      const token = await this.initGoogleAuth();

      this.showBackupProgress('Đang chuẩn bị thư mục trên Drive...', 10);
      const folderId = await this.getOrCreateGDriveFolder(folderName, token);

      this.showBackupProgress('Đang trích xuất dữ liệu kho truyện...', 15);
      const backupData = await this.generateBackupData(contentMode, (msg, pct) => {
        this.showBackupProgress(msg, Math.round(15 + pct * 0.35)); // 15% -> 50%
      });

      if (!backupData) return;

      this.showBackupProgress('Đang nén dữ liệu sao lưu...', 52);
      const jsonStr = JSON.stringify(backupData);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const totalBytes = blob.size;
      const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);

      // Determine filename
      let filename = 'KhoTruyen_Backup.json';
      if (contentMode === 'lite') {
        filename = 'KhoTruyen_Backup_Lite.json';
      }
      if (filenameMode === 'timestamp') {
        const now = new Date();
        const d = now.toISOString().slice(0, 10).replace(/-/g, '');
        const t = now.toTimeString().slice(0, 5).replace(/:/g, '');
        filename = `KhoTruyen_Backup_${d}_${t}.json`;
      }

      this.showBackupProgress(`Đang chuẩn bị tải lên (${totalMB} MB)...`, 55);

      // Check if file already exists in folder for overwrite mode
      let existingFileId = null;
      if (filenameMode === 'overwrite') {
        try {
          let q = `name = '${filename.replace(/'/g, "\\'")}' and trashed = false`;
          if (folderId) {
            q = `'${folderId}' in parents and ${q}`;
          }
          const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (searchRes.ok) {
            const searchData = await searchRes.json();
            if (searchData.files && searchData.files.length > 0) {
              existingFileId = searchData.files[0].id;
            }
          }
        } catch (e) {
          console.warn('Check existing file error:', e);
        }
      }

      // Initiate Resumable Upload Session
      let sessionUrl = '';
      if (existingFileId) {
        // PATCH existing file (keeps version history in Google Drive)
        const initRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=resumable`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'application/json',
            'X-Upload-Content-Length': String(totalBytes),
          },
          body: JSON.stringify({ name: filename }),
        });
        if (!initRes.ok) throw new Error(`Khởi tạo ghi đè thất bại: HTTP ${initRes.status}`);
        sessionUrl = initRes.headers.get('Location');
      } else {
        // POST new file
        const metadata = {
          name: filename,
          mimeType: 'application/json',
        };
        if (folderId) {
          metadata.parents = [folderId];
        }
        const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'application/json',
            'X-Upload-Content-Length': String(totalBytes),
          },
          body: JSON.stringify(metadata),
        });
        if (!initRes.ok) throw new Error(`Khởi tạo tải lên thất bại: HTTP ${initRes.status}`);
        sessionUrl = initRes.headers.get('Location');
      }

      if (!sessionUrl) {
        throw new Error('Google Drive không trả về URL phiên tải lên!');
      }

      // Upload in 1MB chunks
      const chunkSize = 1024 * 1024; // 1 MB
      let offset = 0;

      while (offset < totalBytes) {
        const nextEnd = Math.min(offset + chunkSize, totalBytes);
        const chunk = blob.slice(offset, nextEnd);

        const chunkRes = await fetch(sessionUrl, {
          method: 'PUT',
          headers: {
            'Content-Range': `bytes ${offset}-${nextEnd - 1}/${totalBytes}`,
          },
          body: chunk,
        });

        if (chunkRes.status === 308) {
          offset = nextEnd;
          const uploadedMB = (offset / (1024 * 1024)).toFixed(1);
          const uploadPct = Math.round(55 + (offset / totalBytes) * 43); // 55% -> 98%
          this.showBackupProgress(`Đang đẩy lên Drive: ${uploadedMB}/${totalMB} MB (${Math.round((offset / totalBytes) * 100)}%)...`, uploadPct);
        } else if (chunkRes.status === 200 || chunkRes.status === 201) {
          offset = totalBytes;
          break;
        } else {
          throw new Error(`Lỗi tải lên từng phần: HTTP ${chunkRes.status}`);
        }
      }

      this.showBackupProgress('Đã sao lưu lên Google Drive thành công!', 100);
      const modeText = existingFileId ? 'Đã ghi đè cập nhật' : 'Đã tải lên';
      this.showToast(`${modeText} "${filename}" (${totalMB} MB) vào thư mục "${folderName}" trên Google Drive ✓`, 'success');
      setTimeout(() => this.hideBackupProgress(), 1500);
    } catch (err) {
      console.error('GDrive upload error:', err);
      this.showToast('Lỗi tải lên Google Drive: ' + err.message, 'error');
      this.hideBackupProgress();
    }
  }

  // --- Open Google Drive Restore File List ---
  async openGDriveRestoreList() {
    try {
      const clientId = (this.gdriveClientId || localStorage.getItem('khotruyen_gdrive_client_id') || '').trim();
      if (!clientId) {
        this.showToast('Vui lòng nhập Google Client ID trước!', 'info');
        const input = document.getElementById('gdrive-client-id-input');
        if (input) input.focus();
        return;
      }

      this.showBackupProgress('Đang kết nối Google Drive...', 15);
      const token = await this.initGoogleAuth();

      this.showBackupProgress('Đang quét file sao lưu trên Drive...', 35);
      const folderName = (this.gdriveFolderName || 'KhoTruyen').trim();
      const folderId = await this.getOrCreateGDriveFolder(folderName, token);

      let q = "name contains 'KhoTruyen_Backup' and trashed = false";
      if (folderId) {
        q = `'${folderId}' in parents and ${q}`;
      }

      let res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,modifiedTime)&orderBy=modifiedTime+desc`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        throw new Error(`Máy chủ Google trả về HTTP ${res.status}`);
      }

      let data = await res.json();

      // If no files found inside specific folder, try searching anywhere in Drive
      if ((!data.files || data.files.length === 0) && folderId) {
        const fallbackQ = "name contains 'KhoTruyen_Backup' and trashed = false";
        const fallbackRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(fallbackQ)}&fields=files(id,name,size,modifiedTime)&orderBy=modifiedTime+desc`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (fallbackRes.ok) {
          data = await fallbackRes.json();
        }
      }

      this.hideBackupProgress();

      const listContainer = document.getElementById('gdrive-file-list');
      const itemsContainer = document.getElementById('gdrive-file-items-container');

      if (!data.files || data.files.length === 0) {
        this.showToast('Không tìm thấy bản sao lưu KhoTruyen nào trên Google Drive!', 'info');
        if (listContainer) listContainer.style.display = 'none';
        return;
      }

      if (itemsContainer) {
        itemsContainer.innerHTML = data.files.map((f) => {
          const sizeMB = f.size ? (Number(f.size) / (1024 * 1024)).toFixed(1) + ' MB' : 'N/A';
          const dateStr = f.modifiedTime ? new Date(f.modifiedTime).toLocaleString('vi-VN') : 'Không rõ';
          return `
            <div class="gdrive-file-item">
              <div class="gdrive-file-info">
                <div class="gdrive-file-name">📄 ${this.escapeHTML(f.name)}</div>
                <div class="gdrive-file-meta">Dung lượng: ${sizeMB} • Cập nhật: ${dateStr}</div>
              </div>
              <button class="btn btn-sm btn-primary" onclick="app.downloadAndRestoreGDrive('${f.id}', '${this.escapeHTML(f.name).replace(/'/g, "\\'")}')">
                Nạp bản này
              </button>
            </div>
          `;
        }).join('');
      }

      if (listContainer) {
        listContainer.style.display = 'block';
        listContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (err) {
      console.error('GDrive restore list error:', err);
      this.showToast('Lỗi tìm bản sao lưu: ' + err.message, 'error');
      this.hideBackupProgress();
    }
  }

  // --- Download and restore selected backup from Google Drive ---
  async downloadAndRestoreGDrive(fileId, fileName) {
    const restoreMode = document.querySelector('input[name="restore-mode"]:checked')?.value || 'merge';
    const modeDesc = restoreMode === 'replace' ? 'THAY THẾ TOÀN BỘ kho truyện' : 'GỘP VÀO kho truyện hiện tại';

    if (!confirm(`Bạn có chắc muốn nạp bản sao lưu "${fileName}" từ Google Drive?\nChế độ: ${modeDesc}`)) {
      return;
    }

    try {
      this.showBackupProgress('Đang kết nối Google Drive...', 10);
      const token = await this.initGoogleAuth();

      this.showBackupProgress(`Đang tải "${fileName}" từ Google Drive...`, 25);
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        throw new Error(`Không thể tải file: HTTP ${res.status}`);
      }

      this.showBackupProgress('Đang phân tích dữ liệu sao lưu...', 40);
      const backupData = await res.json();

      await this.applyBackupData(backupData, restoreMode);
    } catch (err) {
      console.error('GDrive restore error:', err);
      this.showToast('Lỗi khôi phục từ Drive: ' + err.message, 'error');
      this.hideBackupProgress();
    }
  }

  blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return res.blob();
  }

  // ==================== BATCH CREATE FROM FOLDERS ====================
  async openBatchModal() {
    this.batchDetectedFolders = [];
    const fileInput = document.getElementById('batch-folder-input');
    if (fileInput) fileInput.value = '';

    const previewSec = document.getElementById('batch-preview-section');
    if (previewSec) previewSec.style.display = 'none';

    const progressCard = document.getElementById('batch-progress-card');
    if (progressCard) progressCard.style.display = 'none';

    const startBtn = document.getElementById('batch-start-btn');
    if (startBtn) startBtn.disabled = false;

    // Populate category dropdown
    this.categories = await this.db.getAllCategories();
    const select = document.getElementById('batch-category-select');
    if (select) {
      let html = '<option value="">-- Không gán danh mục --</option>';
      for (const cat of this.categories) {
        const isSelected = this.selectedCategoryId === cat.id;
        html += `<option value="${cat.id}" ${isSelected ? 'selected' : ''}>📁 ${this.escapeHTML(cat.name)}</option>`;
      }
      select.innerHTML = html;
    }

    const modal = document.getElementById('batch-modal-overlay');
    if (modal) modal.style.display = 'flex';
  }

  closeBatchModal() {
    const modal = document.getElementById('batch-modal-overlay');
    if (modal) modal.style.display = 'none';
    this.batchDetectedFolders = [];
  }

  handleBatchFolderSelect(files) {
    if (!files || files.length === 0) return;

    // Filter image files
    const imageFiles = Array.from(files).filter((f) => {
      const name = f.name.toLowerCase();
      return f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(name);
    });

    if (imageFiles.length === 0) {
      this.showToast('Không tìm thấy file ảnh nào trong thư mục!', 'error');
      return;
    }

    // Group files by subfolder
    const folderMap = new Map();

    for (const file of imageFiles) {
      const path = file.webkitRelativePath || file.name;
      const parts = path.split('/');
      
      // If path has subfolders: MasterFolder/StoryName/01.jpg
      let folderName = '';
      if (parts.length > 2) {
        folderName = parts.slice(1, -1).join(' - ').trim();
      } else if (parts.length === 2) {
        folderName = parts[0];
      } else {
        folderName = 'Truyện mới';
      }

      if (!folderName) folderName = 'Truyện mới';

      if (!folderMap.has(folderName)) {
        folderMap.set(folderName, []);
      }
      folderMap.get(folderName).push(file);
    }

    this.batchDetectedFolders = Array.from(folderMap.entries()).map(([name, fList]) => ({
      name,
      files: fList,
    }));

    // Natural sort folders by name
    this.batchDetectedFolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    this.renderBatchPreview();
  }

  renderBatchPreview() {
    const previewSec = document.getElementById('batch-preview-section');
    const summaryEl = document.getElementById('batch-preview-summary');
    const totalImgsEl = document.getElementById('batch-preview-total-images');
    const listEl = document.getElementById('batch-folder-list');

    if (!this.batchDetectedFolders || this.batchDetectedFolders.length === 0) {
      if (previewSec) previewSec.style.display = 'none';
      return;
    }

    const totalImages = this.batchDetectedFolders.reduce((sum, f) => sum + f.files.length, 0);

    if (summaryEl) summaryEl.textContent = `Tìm thấy ${this.batchDetectedFolders.length} bộ truyện`;
    if (totalImgsEl) totalImgsEl.textContent = `Tổng ${totalImages} ảnh`;

    if (listEl) {
      listEl.innerHTML = this.batchDetectedFolders
        .map(
          (folder) => `
        <div class="batch-folder-item">
          <span class="batch-folder-name" title="${this.escapeHTML(folder.name)}">📖 ${this.escapeHTML(folder.name)}</span>
          <span class="batch-folder-count">${folder.files.length} ảnh</span>
        </div>
      `
        )
        .join('');
    }

    if (previewSec) previewSec.style.display = 'block';
  }

  updateBatchProgress(text, percent) {
    const card = document.getElementById('batch-progress-card');
    const textEl = document.getElementById('batch-status-text');
    const fillEl = document.getElementById('batch-progress-fill');
    if (card) card.style.display = 'flex';
    if (textEl) textEl.textContent = text;
    if (fillEl) fillEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }

  async startBatchImport() {
    if (!this.batchDetectedFolders || this.batchDetectedFolders.length === 0) {
      this.showToast('Chưa có thư mục truyện nào được chọn!', 'error');
      return;
    }

    const selectedCatId = document.getElementById('batch-category-select')?.value;
    const shouldSort = document.getElementById('batch-sort-toggle')?.checked ?? true;
    const totalFolders = this.batchDetectedFolders.length;

    const startBtn = document.getElementById('batch-start-btn');
    if (startBtn) startBtn.disabled = true;

    let createdStoryIds = [];
    let completedCount = 0;

    try {
      for (let fIdx = 0; fIdx < totalFolders; fIdx++) {
        const folder = this.batchDetectedFolders[fIdx];
        const percent = Math.round((fIdx / totalFolders) * 92);
        this.updateBatchProgress(`Đang tạo (${fIdx + 1}/${totalFolders}): ${folder.name}...`, percent);

        let fileList = [...folder.files];
        if (shouldSort) {
          fileList.sort((a, b) => {
            const numA = this.extractNumber(a.name);
            const numB = this.extractNumber(b.name);
            if (numA !== numB) return numA - numB;
            return a.name.localeCompare(b.name, undefined, { numeric: true });
          });
        }

        const storyId = this.generateId();
        const now = Date.now();

        // Thumbnail cover from 1st image
        let coverData = '';
        try {
          coverData = await this.generateThumbnail(fileList[0], 300, 400);
        } catch (e) {
          console.warn('Could not generate cover for batch story:', folder.name);
        }

        const story = {
          id: storyId,
          name: folder.name,
          coverData: coverData,
          imageCount: fileList.length,
          createdAt: now + fIdx,
          updatedAt: now + fIdx,
        };

        await this.db.addStory(story);
        createdStoryIds.push(storyId);

        // Save images as Blobs directly
        for (let i = 0; i < fileList.length; i++) {
          await this.db.addImage({
            id: this.generateId(),
            storyId: storyId,
            name: fileList[i].name,
            data: fileList[i], // Blob
            order: i,
          });
        }

        completedCount++;
      }

      // Assign to category if selected
      if (selectedCatId) {
        this.updateBatchProgress('Đang gán truyện vào danh mục...', 96);
        const cat = this.categories.find((c) => c.id === selectedCatId);
        if (cat) {
          cat.storyIds = cat.storyIds || [];
          for (const sId of createdStoryIds) {
            if (!cat.storyIds.includes(sId)) {
              cat.storyIds.push(sId);
            }
          }
          await this.db.addCategory(cat);
          this.selectedCategoryId = cat.id; // Automatically switch view to this category
        }
      }

      this.updateBatchProgress('Hoàn tất!', 100);
      this.showToast(`Đã tạo thành công ${completedCount} bộ truyện ✓`, 'success');

      setTimeout(async () => {
        this.closeBatchModal();
        await this.loadLibrary();
        await this.updateStorageUI();
      }, 1000);
    } catch (err) {
      console.error('Batch import error:', err);
      if (err.name === 'QuotaExceededError' || err.message?.toLowerCase().includes('quota')) {
        alert('Bộ nhớ điện thoại / trình duyệt đã đầy (QuotaExceededError)! Quá trình tạo truyện phải dừng lại.');
      } else {
        this.showToast('Lỗi khi tạo hàng loạt: ' + err.message, 'error');
      }
      if (startBtn) startBtn.disabled = false;
    }
  }

  // ==================== HITOMI DOWNLOADER ====================
  async openHitomiModal() {
    // If a download is already in progress, re-open modal to show progress
    if (this.hitomiAbortController) {
      this.hideFloatingProgress();
      const modal = document.getElementById('hitomi-modal-overlay');
      if (modal) modal.style.display = 'flex';
      const progressCard = document.getElementById('hitomi-progress-card');
      if (progressCard) {
        progressCard.style.display = 'flex';
        progressCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }

    this.hitomiScannedGalleries = [];
    this.hitomiSelectedGalleryIds.clear();
    this.hitomiScannedTitle = '';
    this.hitomiLastScanUrl = '';
    this.hitomiTotalFound = 0;
    this.hitomiHasMore = false;
    this.hitomiNextOffset = 0;
    this.hitomiSubtitle = '';
    this._hitomiLoadingMore = false;
    this.updateHitomiLoadMoreUI();

    const proxyInput = document.getElementById('hitomi-proxy-url-input');
    if (proxyInput) proxyInput.value = this.hitomiProxyUrl;

    const proxyBody = document.getElementById('hitomi-proxy-body');
    const proxyArrow = document.getElementById('hitomi-proxy-toggle-arrow');
    // If no proxy set, open settings automatically so user sees it
    if (!this.hitomiProxyUrl && proxyBody) {
      proxyBody.style.display = 'block';
      if (proxyArrow) proxyArrow.style.transform = 'rotate(180deg)';
    }

    const previewSec = document.getElementById('hitomi-preview-section');
    if (previewSec) previewSec.style.display = 'none';

    const progressCard = document.getElementById('hitomi-progress-card');
    if (progressCard) progressCard.style.display = 'none';

    const footerBtn = document.getElementById('hitomi-start-btn-footer');
    if (footerBtn) footerBtn.style.display = 'none';

    const modalBody = document.getElementById('hitomi-modal-body');
    if (modalBody) modalBody.scrollTop = 0;

    const scanBtn = document.getElementById('hitomi-scan-btn');
    if (scanBtn) scanBtn.disabled = false;

    // Populate category dropdown
    this.categories = await this.db.getAllCategories();
    const select = document.getElementById('hitomi-category-select');
    if (select) {
      let html = `
        <option value="">-- Tự tạo danh mục theo tên tác giả --</option>
        <option value="_none_">-- Không gán danh mục --</option>
      `;
      for (const cat of this.categories) {
        html += `<option value="${cat.id}">📁 ${this.escapeHTML(cat.name)}</option>`;
      }
      select.innerHTML = html;
    }

    const modal = document.getElementById('hitomi-modal-overlay');
    if (modal) modal.style.display = 'flex';
  }

  closeHitomiModal() {
    // If download is running, minimize instead of aborting
    if (this.hitomiAbortController) {
      this.minimizeHitomiModal();
      return;
    }
    const modal = document.getElementById('hitomi-modal-overlay');
    if (modal) modal.style.display = 'none';
  }

  minimizeHitomiModal() {
    const modal = document.getElementById('hitomi-modal-overlay');
    if (modal) modal.style.display = 'none';
    if (this.hitomiAbortController) {
      this.showFloatingProgress();
      this.showToast('Đang tải ngầm dưới nền... Bạn có thể đọc truyện bình thường!', 'info');
    }
  }

  promptCancelHitomiDownload() {
    if (confirm('Bạn có chắc muốn huỷ quá trình tải này không?')) {
      this.cancelHitomiDownload();
    }
  }

  showFloatingProgress() {
    const f = document.getElementById('hitomi-floating-progress');
    if (f) f.style.display = 'flex';
  }

  hideFloatingProgress() {
    const f = document.getElementById('hitomi-floating-progress');
    if (f) f.style.display = 'none';
  }

  toggleHitomiProxySettings() {
    const body = document.getElementById('hitomi-proxy-body');
    const arrow = document.getElementById('hitomi-proxy-toggle-arrow');
    if (body) {
      const isHidden = body.style.display === 'none';
      body.style.display = isHidden ? 'block' : 'none';
      if (arrow) arrow.style.transform = isHidden ? 'rotate(180deg)' : 'none';
    }
  }

  async testHitomiProxy() {
    const input = document.getElementById('hitomi-proxy-url-input');
    let url = input ? input.value.trim().replace(/\/+$/, '') : '';
    const statusEl = document.getElementById('hitomi-proxy-status');

    if (!url) {
      this.showToast('Vui lòng nhập địa chỉ Worker!', 'error');
      return;
    }

    if (!url.startsWith('http')) {
      url = 'https://' + url;
      if (input) input.value = url;
    }

    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.style.color = 'var(--text-muted)';
      statusEl.textContent = 'Đang kiểm tra kết nối...';
    }

    try {
      const res = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error('HTTP 404 (Chưa bật URL). Trên Cloudflare hãy bấm vào tab "Domains" và chọn "Enable" cho workers.dev!');
        }
        throw new Error(`Máy chủ trả về HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data && data.status === 'ok') {
        this.hitomiProxyUrl = url;
        localStorage.setItem('khotruyen_hitomi_proxy', url);
        if (statusEl) {
          statusEl.style.color = 'var(--success)';
          statusEl.textContent = '✓ Kết nối Worker thành công! Đã lưu cài đặt.';
        }
        this.showToast('Đã lưu cấu hình Proxy Worker ✓', 'success');
      } else {
        throw new Error('Worker phản hồi không hợp lệ');
      }
    } catch (e) {
      if (statusEl) {
        statusEl.style.color = 'var(--danger)';
        statusEl.textContent = `✕ Không thể kết nối: ${e.message}. Hãy kiểm tra lại URL!`;
      }
    }
  }

  async pasteHitomiUrl() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          const input = document.getElementById('hitomi-url-input');
          if (input) {
            input.value = text.trim();
            this.showToast('Đã dán link từ bộ nhớ tạm ✓', 'success');
          }
          return;
        }
      }
      this.showToast('Hãy bấm giữ vào ô và chọn Dán', 'info');
    } catch (e) {
      this.showToast('Hãy bấm giữ vào ô và chọn Dán', 'info');
    }
  }

  async scanHitomiUrl() {
    const urlInput = document.getElementById('hitomi-url-input');
    const proxyInput = document.getElementById('hitomi-proxy-url-input');
    const rawUrl = urlInput ? urlInput.value.trim() : '';

    if (!rawUrl) {
      this.showToast('Vui lòng nhập hoặc dán đường link Hitomi!', 'error');
      if (urlInput) urlInput.focus();
      return;
    }

    // Save proxy url if typed
    if (proxyInput && proxyInput.value.trim()) {
      let pUrl = proxyInput.value.trim().replace(/\/+$/, '');
      if (!pUrl.startsWith('http')) pUrl = 'https://' + pUrl;
      this.hitomiProxyUrl = pUrl;
      localStorage.setItem('khotruyen_hitomi_proxy', pUrl);
    }

    if (!this.hitomiProxyUrl) {
      this.toggleHitomiProxySettings();
      alert('Bạn chưa cài đặt địa chỉ Cloudflare Worker làm Proxy! Hãy xem hướng dẫn trong thư mục "cloudflare-worker/" hoặc dán URL Worker vào ô Cấu hình bên trên.');
      return;
    }

    const spinner = document.getElementById('hitomi-scan-spinner');
    const btnText = document.getElementById('hitomi-scan-btn-text');
    const scanBtn = document.getElementById('hitomi-scan-btn');
    const previewSec = document.getElementById('hitomi-preview-section');
    const footerBtn = document.getElementById('hitomi-start-btn-footer');

    if (spinner) spinner.style.display = 'inline-block';
    if (btnText) btnText.textContent = 'Đang quét dữ liệu...';
    if (scanBtn) scanBtn.disabled = true;
    if (footerBtn) footerBtn.style.display = 'none';

    try {
      const res = await fetch(`${this.hitomiProxyUrl}/api/parse?url=${encodeURIComponent(rawUrl)}&offset=0&limit=30`);
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error('HTTP 404: Worker chưa được kích hoạt URL. Trên Cloudflare hãy bấm vào tab "Domains" và chọn "Enable" cho workers.dev!');
        }
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Lỗi máy chủ HTTP ${res.status}`);
      }

      const data = await res.json();
      this.hitomiScannedGalleries = [];
      this.hitomiSelectedGalleryIds.clear();
      this.hitomiLastScanUrl = rawUrl;
      this.hitomiTotalFound = 0;
      this.hitomiHasMore = false;
      this.hitomiNextOffset = 0;
      this.hitomiSubtitle = '';

      let rawGalleries = [];
      if (data.type === 'single') {
        rawGalleries = [data.gallery];
        this.hitomiScannedTitle = data.gallery.title;
        this.hitomiTotalFound = 1;
        this.hitomiHasMore = false;
        this.hitomiNextOffset = 1;
        this.hitomiSubtitle = data.gallery.artists?.length ? data.gallery.artists.join(', ') : '';
      } else if (data.type === 'collection') {
        rawGalleries = data.galleries || [];
        this.hitomiScannedTitle = data.pageTitle || 'Hitomi Collection';
        this.hitomiTotalFound = Number.isFinite(Number(data.totalFound))
          ? Number(data.totalFound)
          : rawGalleries.length;
        this.hitomiHasMore = Boolean(data.hasMore);
        this.hitomiNextOffset = (Number(data.offset) || 0) + rawGalleries.length;
        this.hitomiSubtitle = data.subtitle || '';
      }

      if (rawGalleries.length === 0) {
        this.updateHitomiLoadMoreUI();
        this.showToast('Không tìm thấy bộ truyện nào từ link này!', 'error');
        if (previewSec) previewSec.style.display = 'none';
        if (footerBtn) footerBtn.style.display = 'none';
        return;
      }

      // Check existing stories in database for duplicate detection
      const existingStories = await this.db.getAllStories();
      const existingTitles = new Set(existingStories.map((s) => s.name?.trim().toLowerCase()).filter(Boolean));
      const existingIds = new Set(existingStories.map((s) => String(s.hitomiGalleryId || '')).filter(Boolean));

      this.hitomiScannedGalleries = rawGalleries.map((g) => {
        const isDup = existingIds.has(String(g.id)) || existingTitles.has(g.title?.trim().toLowerCase());
        return { ...g, isDuplicate: isDup };
      });

      // By default, auto-select ONLY non-duplicate galleries!
      let newCount = 0;
      this.hitomiScannedGalleries.forEach((g) => {
        if (!g.isDuplicate) {
          this.hitomiSelectedGalleryIds.add(g.id);
          newCount++;
        }
      });

      this.renderHitomiGalleryList();
      this.updateHitomiLoadMoreUI();
      if (previewSec) {
        previewSec.style.display = 'block';
        setTimeout(() => {
          previewSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
      }
      if (footerBtn) footerBtn.style.display = 'inline-flex';

      const dupCount = this.hitomiScannedGalleries.length - newCount;
      const totalSuffix =
        this.hitomiTotalFound > this.hitomiScannedGalleries.length
          ? ` (hiển thị ${this.hitomiScannedGalleries.length}/${this.hitomiTotalFound} bộ)`
          : '';
      if (dupCount > 0) {
        this.showToast(`Tìm thấy ${this.hitomiScannedGalleries.length} bộ${totalSuffix} (${dupCount} đã có trong kho, chọn sẵn ${newCount} bộ mới) ✓`, 'info');
      } else {
        this.showToast(`Tìm thấy ${this.hitomiScannedGalleries.length} bộ truyện mới${totalSuffix}! ✓`, 'success');
      }
    } catch (err) {
      console.error('Hitomi scan error:', err);
      alert('Lỗi khi quét link Hitomi: ' + err.message + '\n\nLưu ý: Đảm bảo bạn đã triển khai Cloudflare Worker và nhập đúng link Worker.');
    } finally {
      if (spinner) spinner.style.display = 'none';
      if (btnText) btnText.textContent = '🔍 Quét link & Lấy danh sách';
      if (scanBtn) scanBtn.disabled = false;
    }
  }

  updateHitomiLoadMoreUI() {
    const loadMoreBtn = document.getElementById('hitomi-load-more-btn');
    const loadMoreText = document.getElementById('hitomi-load-more-text');
    const subtitle = document.getElementById('hitomi-preview-subtitle');

    const totalCount = this.hitomiScannedGalleries.length;
    const dupCount = this.hitomiScannedGalleries.filter((g) => g.isDuplicate).length;
    const newCount = totalCount - dupCount;
    const remaining = Math.max(0, (this.hitomiTotalFound || totalCount) - totalCount);

    if (loadMoreBtn) {
      loadMoreBtn.style.display = this.hitomiHasMore ? 'inline-flex' : 'none';
    }
    if (loadMoreText && !this._hitomiLoadingMore) {
      loadMoreText.textContent =
        remaining > 0
          ? `➕ Tải thêm (${remaining} bộ còn lại)`
          : '➕ Tải thêm danh sách';
    }

    if (subtitle) {
      const parts = [];
      if (this.hitomiScannedTitle) parts.push(this.hitomiScannedTitle);
      if (this.hitomiSubtitle) parts.push(this.hitomiSubtitle);
      if (this.hitomiTotalFound > totalCount) {
        parts.push(`Đang hiện ${totalCount}/${this.hitomiTotalFound} bộ`);
      }
      if (dupCount > 0) {
        parts.push(`${dupCount} bộ đã có trong kho, ${newCount} bộ mới`);
      } else if (totalCount > 0) {
        parts.push(`${totalCount} bộ mới`);
      }
      subtitle.textContent = parts.join(' • ');
    }
  }

  async loadMoreHitomiGalleries() {
    if (this._hitomiLoadingMore || !this.hitomiHasMore || !this.hitomiLastScanUrl || !this.hitomiProxyUrl) {
      return;
    }

    this._hitomiLoadingMore = true;
    const loadMoreBtn = document.getElementById('hitomi-load-more-btn');
    const loadMoreSpinner = document.getElementById('hitomi-load-more-spinner');
    const loadMoreText = document.getElementById('hitomi-load-more-text');

    if (loadMoreBtn) loadMoreBtn.disabled = true;
    if (loadMoreSpinner) loadMoreSpinner.style.display = 'inline-block';
    if (loadMoreText) loadMoreText.textContent = 'Đang tải thêm...';

    try {
      const url = `${this.hitomiProxyUrl}/api/parse?url=${encodeURIComponent(this.hitomiLastScanUrl)}&offset=${this.hitomiNextOffset}&limit=30`;
      const res = await fetch(url);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Lỗi máy chủ HTTP ${res.status}`);
      }

      const data = await res.json();
      const rawGalleries = Array.isArray(data.galleries) ? data.galleries : [];

      const existingStories = await this.db.getAllStories();
      const existingTitles = new Set(existingStories.map((s) => s.name?.trim().toLowerCase()).filter(Boolean));
      const existingIds = new Set(existingStories.map((s) => String(s.hitomiGalleryId || '')).filter(Boolean));
      const alreadyScannedIds = new Set(this.hitomiScannedGalleries.map((g) => String(g.id)));

      let addedCount = 0;
      let addedNewCount = 0;

      for (const g of rawGalleries) {
        const gIdStr = String(g.id);
        if (alreadyScannedIds.has(gIdStr)) continue;
        alreadyScannedIds.add(gIdStr);

        const isDup = existingIds.has(gIdStr) || existingTitles.has(g.title?.trim().toLowerCase());
        this.hitomiScannedGalleries.push({ ...g, isDuplicate: isDup });
        addedCount++;
        if (!isDup) {
          this.hitomiSelectedGalleryIds.add(g.id);
          addedNewCount++;
        }
      }

      const baseOffset = Number.isFinite(Number(data.offset)) ? Number(data.offset) : this.hitomiNextOffset;
      this.hitomiNextOffset = baseOffset + rawGalleries.length;
      if (Number.isFinite(Number(data.totalFound))) {
        this.hitomiTotalFound = Number(data.totalFound);
      } else {
        this.hitomiTotalFound = Math.max(this.hitomiTotalFound, this.hitomiScannedGalleries.length);
      }
      this.hitomiHasMore = rawGalleries.length > 0 && Boolean(data.hasMore);
      if (data.subtitle && !this.hitomiSubtitle) {
        this.hitomiSubtitle = data.subtitle;
      }

      this.renderHitomiGalleryList();
      this.updateHitomiLoadMoreUI();

      if (addedCount > 0) {
        this.showToast(
          `Đã tải thêm ${addedCount} bộ (${addedNewCount} bộ mới được chọn sẵn) ✓`,
          addedNewCount > 0 ? 'success' : 'info'
        );
      } else {
        this.showToast('Không có bộ truyện mới nào ở trang tiếp theo.', 'info');
      }
    } catch (err) {
      console.error('Hitomi load more error:', err);
      this.showToast('Lỗi tải thêm danh sách: ' + err.message, 'error');
    } finally {
      this._hitomiLoadingMore = false;
      if (loadMoreBtn) loadMoreBtn.disabled = false;
      if (loadMoreSpinner) loadMoreSpinner.style.display = 'none';
      this.updateHitomiLoadMoreUI();
    }
  }

  updateHitomiSelectionCount() {
    const count = this.hitomiSelectedGalleryIds.size;
    const countEl = document.getElementById('hitomi-selected-count');
    const countFooterEl = document.getElementById('hitomi-selected-count-footer');
    if (countEl) countEl.textContent = count;
    if (countFooterEl) countFooterEl.textContent = count;

    const startBtn = document.getElementById('hitomi-start-btn');
    const footerBtn = document.getElementById('hitomi-start-btn-footer');
    const disabled = count === 0;

    if (startBtn) {
      startBtn.disabled = disabled;
      startBtn.innerHTML = disabled
        ? 'Chưa chọn bộ nào để tải'
        : `🚀 Bắt đầu tải về (<span id="hitomi-selected-count">${count}</span> bộ)`;
    }
    if (footerBtn) {
      footerBtn.disabled = disabled;
      footerBtn.innerHTML = disabled
        ? 'Chưa chọn bộ nào'
        : `🚀 Bắt đầu tải (<span id="hitomi-selected-count-footer">${count}</span> bộ)`;
    }
  }

  renderHitomiGalleryList() {
    const list = document.getElementById('hitomi-gallery-list');
    const summary = document.getElementById('hitomi-preview-summary');

    const totalCount = this.hitomiScannedGalleries.length;
    if (summary) {
      summary.textContent =
        this.hitomiTotalFound > totalCount
          ? `Hiển thị ${totalCount} / ${this.hitomiTotalFound} bộ truyện`
          : `Tìm thấy ${totalCount} bộ truyện`;
    }
    this.updateHitomiLoadMoreUI();
    this.updateHitomiSelectionCount();

    if (!list) return;

    list.innerHTML = this.hitomiScannedGalleries
      .map((gallery) => {
        const isSelected = this.hitomiSelectedGalleryIds.has(gallery.id);
        const isDup = gallery.isDuplicate;
        return `
          <div class="hitomi-gallery-item ${isSelected ? 'selected' : ''} ${isDup ? 'is-duplicate' : ''}" data-id="${gallery.id}" onclick="app.toggleHitomiGallerySelection('${gallery.id}')">
            <div class="custom-checkbox ${isSelected ? 'checked' : ''}" style="margin-right: 2px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
            <div class="hitomi-gallery-info">
              <div class="hitomi-gallery-title" title="${this.escapeHTML(gallery.title)}">${this.escapeHTML(gallery.title)}</div>
              <div class="hitomi-gallery-meta">
                <span>Mã: #${gallery.id}</span>
                ${gallery.pageCount ? `<span>🖼️ ${gallery.pageCount} trang</span>` : ''}
                ${isDup ? `<span class="hitomi-duplicate-tag">✓ Đã có trong kho</span>` : ''}
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  toggleHitomiGallerySelection(id) {
    if (this.hitomiSelectedGalleryIds.has(id)) {
      this.hitomiSelectedGalleryIds.delete(id);
    } else {
      this.hitomiSelectedGalleryIds.add(id);
    }

    const item = document.querySelector(`.hitomi-gallery-item[data-id="${id}"]`);
    if (item) {
      if (this.hitomiSelectedGalleryIds.has(id)) {
        item.classList.add('selected');
        item.querySelector('.custom-checkbox')?.classList.add('checked');
      } else {
        item.classList.remove('selected');
        item.querySelector('.custom-checkbox')?.classList.remove('checked');
      }
    }

    this.updateHitomiSelectionCount();
  }

  selectAllHitomiGalleries(selectAll) {
    if (selectAll) {
      this.hitomiScannedGalleries.forEach((g) => this.hitomiSelectedGalleryIds.add(g.id));
    } else {
      this.hitomiSelectedGalleryIds.clear();
    }
    this.renderHitomiGalleryList();
  }

  selectOnlyNewHitomiGalleries() {
    this.hitomiSelectedGalleryIds.clear();
    this.hitomiScannedGalleries.forEach((g) => {
      if (!g.isDuplicate) {
        this.hitomiSelectedGalleryIds.add(g.id);
      }
    });
    this.renderHitomiGalleryList();
    const count = this.hitomiSelectedGalleryIds.size;
    this.showToast(`Đã chọn ${count} bộ truyện mới ✓`, 'info');
  }

  updateDownloadProgress(data) {
    const { gIdx, totalGalleries, galleryTitle, currentImg, totalImages, overallPercent } = data;
    const progressCard = document.getElementById('hitomi-progress-card');
    const statusText = document.getElementById('hitomi-status-text');
    const detailText = document.getElementById('hitomi-detail-status-text');
    const percentText = document.getElementById('hitomi-percent-text');
    const fillEl = document.getElementById('hitomi-progress-fill');

    if (progressCard) progressCard.style.display = 'flex';
    if (statusText) statusText.textContent = `[${gIdx + 1}/${totalGalleries}] ${galleryTitle}`;
    if (detailText) {
      detailText.textContent = totalImages > 0
        ? `Đang tải trang ${currentImg} / ${totalImages} (Tải song song 3 luồng)`
        : 'Đang chuẩn bị...';
    }
    if (percentText) percentText.textContent = `${overallPercent}%`;
    if (fillEl) fillEl.style.width = `${overallPercent}%`;

    // Floating background bar
    const floatingTitle = document.getElementById('hitomi-floating-title');
    const floatingDetail = document.getElementById('hitomi-floating-detail');
    const floatingPercent = document.getElementById('hitomi-floating-percent');
    const floatingFill = document.getElementById('hitomi-floating-fill');

    if (floatingTitle) floatingTitle.textContent = `[${gIdx + 1}/${totalGalleries}] ${galleryTitle}`;
    if (floatingDetail) {
      floatingDetail.textContent = totalImages > 0
        ? `Bộ ${gIdx + 1}/${totalGalleries} • Trang ${currentImg}/${totalImages}`
        : `Bộ ${gIdx + 1}/${totalGalleries}`;
    }
    if (floatingPercent) floatingPercent.textContent = `${overallPercent}%`;
    if (floatingFill) floatingFill.style.width = `${overallPercent}%`;
  }

  cancelHitomiDownload() {
    if (this.hitomiAbortController) {
      this.hitomiAbortController.abort();
      this.hitomiAbortController = null;
      this.showToast('Đã dừng tải truyện.', 'info');
      const progressCard = document.getElementById('hitomi-progress-card');
      if (progressCard) progressCard.style.display = 'none';
      this.hideFloatingProgress();
      const startBtn = document.getElementById('hitomi-start-btn');
      const footerBtn = document.getElementById('hitomi-start-btn-footer');
      if (startBtn) startBtn.disabled = false;
      if (footerBtn) footerBtn.disabled = false;
    }
  }

  async assignStoriesToHitomiCategory(storyIds, selectedCatId, detectedArtistName) {
    if (!Array.isArray(storyIds) || storyIds.length === 0) return;
    if (selectedCatId === '') {
      const catName = detectedArtistName
        ? `Tác giả: ${detectedArtistName}`
        : (this.hitomiScannedTitle || 'Hitomi');
      const allCats = await this.db.getAllCategories();
      let cat = allCats.find((c) => c.name.toLowerCase() === catName.toLowerCase());
      if (!cat) {
        cat = {
          id: 'cat_' + this.generateId(),
          name: catName,
          storyIds: [...storyIds],
          createdAt: Date.now(),
        };
      } else {
        cat.storyIds = Array.from(new Set([...(cat.storyIds || []), ...storyIds]));
        cat.updatedAt = Date.now();
      }
      await this.db.addCategory(cat);
      this.selectedCategoryId = cat.id;
    } else if (selectedCatId !== '_none_') {
      const cat = await this.db.getCategory(selectedCatId);
      if (cat) {
        cat.storyIds = Array.from(new Set([...(cat.storyIds || []), ...storyIds]));
        cat.updatedAt = Date.now();
        await this.db.addCategory(cat);
        this.selectedCategoryId = cat.id;
      }
    }
  }

  async startHitomiDownload() {
    const selectedGalleries = this.hitomiScannedGalleries.filter((g) =>
      this.hitomiSelectedGalleryIds.has(g.id)
    );

    if (selectedGalleries.length === 0) {
      this.showToast('Vui lòng chọn ít nhất 1 bộ truyện để tải!', 'error');
      return;
    }

    const selectedCatId = document.getElementById('hitomi-category-select')?.value ?? '';
    const progressCard = document.getElementById('hitomi-progress-card');
    const startBtn = document.getElementById('hitomi-start-btn');
    const footerBtn = document.getElementById('hitomi-start-btn-footer');

    if (progressCard) {
      progressCard.style.display = 'flex';
      setTimeout(() => {
        progressCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    }
    if (startBtn) startBtn.disabled = true;
    if (footerBtn) footerBtn.disabled = true;

    this.hitomiAbortController = new AbortController();
    const signal = this.hitomiAbortController.signal;

    let completedGalleries = 0;
    const totalGalleries = selectedGalleries.length;
    const createdStoryIds = [];
    let detectedArtistName = '';
    let categoriesAssigned = false;

    try {
      for (let gIdx = 0; gIdx < totalGalleries; gIdx++) {
        if (signal.aborted) break;

        const gItem = selectedGalleries[gIdx];
        this.updateDownloadProgress({
          gIdx,
          totalGalleries,
          galleryTitle: gItem.title,
          currentImg: 0,
          totalImages: 0,
          overallPercent: Math.round((gIdx / totalGalleries) * 100),
        });

        // 1. Fetch gallery details
        const gRes = await fetch(`${this.hitomiProxyUrl}/api/gallery?id=${gItem.id}`, { signal });
        if (!gRes.ok) {
          console.warn(`Could not load details for gallery #${gItem.id}`);
          continue;
        }

        const galleryData = await gRes.json();
        const imagesList = galleryData.images || [];

        if (imagesList.length === 0) {
          console.warn(`Gallery #${gItem.id} has no images`);
          continue;
        }

        if (galleryData.artists && galleryData.artists.length > 0 && !detectedArtistName) {
          detectedArtistName = galleryData.artists[0];
        }

        const storyId = this.generateId();
        const now = Date.now();
        const totalImages = imagesList.length;
        let coverBlob = null;
        let savedImagesCount = 0;
        let completedImages = 0;
        let storySaved = false;

        try {
          // 2. Download images in parallel with Concurrency = 3 and exponential backoff
          const CONCURRENCY = 3;
          let nextIndex = 0;

          const downloadWorker = async () => {
            while (nextIndex < totalImages && !signal.aborted) {
              const imgIdx = nextIndex++;
              const imgObj = imagesList[imgIdx];

              // Up to 2 retries on network glitch with exponential backoff (600ms, 1200ms)
              let blob = null;
              let lastErr = null;
              for (let attempt = 0; attempt < 3; attempt++) {
                if (signal.aborted) break;
                try {
                  const imgFetchUrl = `${this.hitomiProxyUrl}/api/image?url=${encodeURIComponent(imgObj.url)}&id=${gItem.id}`;
                  const imgBlobRes = await fetch(imgFetchUrl, { signal });
                  if (!imgBlobRes.ok) throw new Error(`HTTP ${imgBlobRes.status}`);
                  blob = await imgBlobRes.blob();
                  break;
                } catch (err) {
                  lastErr = err;
                  if (signal.aborted) break;
                  if (attempt < 2) {
                    const delayMs = 600 * Math.pow(2, attempt);
                    await new Promise((resolve) => {
                      const timer = setTimeout(resolve, delayMs);
                      signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        resolve();
                      }, { once: true });
                    });
                  }
                }
              }

              if (signal.aborted) break;
              if (!blob) {
                throw new Error(`Lỗi tải trang ${imgIdx + 1}: ${lastErr?.message || 'Không thể tải ảnh'}`);
              }

              // Save image immediately to IndexedDB without holding all blobs in RAM
              await this.db.addImage({
                id: this.generateId(),
                storyId: storyId,
                name: imgObj.name || `Trang ${imgIdx + 1}`,
                data: blob,
                order: imgIdx,
              });

              if (imgIdx === 0 || !coverBlob) {
                coverBlob = blob;
              }
              savedImagesCount++;
              completedImages++;

              const overallPercent = Math.round(((gIdx + (completedImages / totalImages)) / totalGalleries) * 100);
              this.updateDownloadProgress({
                gIdx,
                totalGalleries,
                galleryTitle: galleryData.title || gItem.title,
                currentImg: completedImages,
                totalImages,
                overallPercent,
              });
            }
          };

          const workers = Array.from(
            { length: Math.min(CONCURRENCY, totalImages) },
            () => downloadWorker()
          );
          await Promise.all(workers);

          if (signal.aborted) {
            throw new Error('ABORTED');
          }

          // 3. Create thumbnail cover from 1st image and release Blob ref
          let coverData = '';
          if (coverBlob) {
            try {
              coverData = await this.generateThumbnail(coverBlob, 300, 400);
            } catch (e) {
              console.warn('Could not generate cover for hitomi story:', galleryData.title);
            }
            coverBlob = null;
          }

          // 4. Save story metadata (including hitomiGalleryId for future duplicate detection!)
          const story = {
            id: storyId,
            name: galleryData.title || gItem.title,
            coverData: coverData,
            imageCount: savedImagesCount,
            hitomiGalleryId: gItem.id,
            createdAt: now + gIdx,
            updatedAt: now + gIdx,
          };

          await this.db.addStory(story);
          storySaved = true;
          createdStoryIds.push(storyId);
          completedGalleries++;

          // Mark as duplicate in active scanned list so UI updates immediately
          gItem.isDuplicate = true;
        } catch (galleryErr) {
          coverBlob = null;
          if (!storySaved) {
            try {
              await this.db.deleteStory(storyId);
            } catch (cleanupErr) {
              console.warn('Could not clean up orphan story images:', cleanupErr);
            }
          }
          if (signal.aborted) {
            break;
          }
          throw galleryErr;
        }
      }

      if (!signal.aborted && completedGalleries > 0) {
        await this.assignStoriesToHitomiCategory(createdStoryIds, selectedCatId, detectedArtistName);
        categoriesAssigned = true;

        this.updateDownloadProgress({
          gIdx: totalGalleries - 1,
          totalGalleries,
          galleryTitle: 'Hoàn tất tải về!',
          currentImg: 100,
          totalImages: 100,
          overallPercent: 100,
        });

        const statusText = document.getElementById('hitomi-status-text');
        const detailText = document.getElementById('hitomi-detail-status-text');
        if (statusText) statusText.textContent = 'Hoàn tất tải về!';
        if (detailText) detailText.textContent = `Đã lưu an toàn ${completedGalleries} bộ truyện vào kho!`;

        const floatingTitle = document.getElementById('hitomi-floating-title');
        const floatingDetail = document.getElementById('hitomi-floating-detail');
        if (floatingTitle) floatingTitle.textContent = '✓ Hoàn tất tải về!';
        if (floatingDetail) floatingDetail.textContent = `Đã lưu ${completedGalleries} bộ truyện`;

        this.showToast(`Đã tải thành công ${completedGalleries} bộ truyện vào app ✓`, 'success');

        setTimeout(async () => {
          this.hideFloatingProgress();
          this.closeHitomiModal();
          await this.loadLibrary();
          await this.updateStorageUI();
        }, 1500);
      }
    } catch (err) {
      if (signal.aborted) {
        console.log('Download aborted by user');
      } else {
        console.error('Hitomi download error:', err);
        if (err.name === 'QuotaExceededError' || err.message?.toLowerCase().includes('quota')) {
          alert('Bộ nhớ điện thoại / trình duyệt đã đầy (QuotaExceededError)! Hãy xoá bớt truyện hoặc sao lưu trước khi tải tiếp.');
        } else {
          this.showToast('Lỗi khi tải truyện: ' + err.message, 'error');
        }
      }
    } finally {
      if (!categoriesAssigned && createdStoryIds.length > 0) {
        try {
          await this.assignStoriesToHitomiCategory(createdStoryIds, selectedCatId, detectedArtistName);
          categoriesAssigned = true;
          await this.loadLibrary();
          await this.updateStorageUI();
        } catch (assignErr) {
          console.warn('Could not assign completed stories to category after partial download:', assignErr);
        }
      }
      this.hitomiAbortController = null;
      if (startBtn) startBtn.disabled = false;
      if (footerBtn) footerBtn.disabled = false;
      setTimeout(() => this.hideFloatingProgress(), 4000);
    }
  }

  // ==================== TOAST ====================
  showToast(message, type = '') {
    // Remove existing toast
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 2500);
  }

  // ==================== EVENTS ====================
  bindEvents() {
    // Search
    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', (e) => {
      this.searchTerm = e.target.value;
      this.loadLibrary();
    });

    // File input
    const fileInput = document.getElementById('file-input');
    fileInput.addEventListener('change', (e) => {
      this.handleFileSelect(e.target.files);
      e.target.value = ''; // Reset to allow same file
    });

    // Backup file input
    const backupFileInput = document.getElementById('backup-file-input');
    backupFileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        this.importBackup(file);
      }
      e.target.value = '';
    });

    // Auto-sort toggle
    const sortToggle = document.getElementById('auto-sort-toggle');
    sortToggle.addEventListener('change', () => {
      this.toggleAutoSort();
    });

    // Upload area click
    const uploadArea = document.getElementById('upload-area');
    uploadArea.addEventListener('click', () => {
      fileInput.click();
    });

    // Folder input
    const folderInput = document.getElementById('folder-input');
    folderInput.addEventListener('change', (e) => {
      this.handleFileSelect(e.target.files);
      e.target.value = '';
    });

    // Upload folder area click
    const uploadFolderArea = document.getElementById('upload-folder-area');
    uploadFolderArea.addEventListener('click', () => {
      folderInput.click();
    });

    // Drag & drop on upload area
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = 'var(--accent)';
      uploadArea.style.background = 'rgba(108, 92, 231, 0.05)';
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.style.borderColor = '';
      uploadArea.style.background = '';
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = '';
      uploadArea.style.background = '';
      this.handleFileSelect(e.dataTransfer.files);
    });

    // Reader tap to toggle UI / tap zones / double-tap to zoom 2x
    const readerContent = document.getElementById('reader-content');
    if (readerContent) {
      let swipeStartX = 0;
      let swipeStartY = 0;
      let swipeStartTime = 0;
      let swipeTracking = false;

      readerContent.addEventListener(
        'touchstart',
        (e) => {
          if (!this.isSinglePageMode() || e.touches.length !== 1) {
            swipeTracking = false;
            return;
          }
          const zoomedWrap = readerContent.querySelector('.reader-page-wrap.active-single-page.zoomed');
          if (zoomedWrap) {
            swipeTracking = false;
            return;
          }
          swipeStartX = e.touches[0].clientX;
          swipeStartY = e.touches[0].clientY;
          swipeStartTime = Date.now();
          swipeTracking = true;
        },
        { passive: true }
      );

      readerContent.addEventListener(
        'touchend',
        (e) => {
          if (!swipeTracking || !this.isSinglePageMode() || e.changedTouches.length !== 1) return;
          swipeTracking = false;
          const zoomedWrap = readerContent.querySelector('.reader-page-wrap.active-single-page.zoomed');
          if (zoomedWrap) return;

          const dx = e.changedTouches[0].clientX - swipeStartX;
          const dy = e.changedTouches[0].clientY - swipeStartY;
          const dt = Date.now() - swipeStartTime;

          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2 && dt < 700) {
            this._lastSwipeTime = Date.now();
            clearTimeout(this._singleTapTimer);
            this._singleTapTimer = null;
            if (this.readerSettings.mode === 'single-rtl') {
              this.stepReaderPage(dx > 0 ? 1 : -1);
            } else {
              this.stepReaderPage(dx > 0 ? -1 : 1);
            }
          }
        },
        { passive: true }
      );

      readerContent.addEventListener('click', (e) => {
        if (e.target.closest('.reader-end-nav') || e.target.closest('button')) return;
        if (Date.now() - (this._lastSwipeTime || 0) < 350) return;

        const now = Date.now();
        const pageWrap = e.target.closest('.reader-page-wrap');
        const dx = e.clientX - (this._lastTapX || 0);
        const dy = e.clientY - (this._lastTapY || 0);
        const isDoubleTap = pageWrap && now - (this._lastTapTime || 0) < 260 && Math.hypot(dx, dy) < 35;

        if (isDoubleTap) {
          clearTimeout(this._singleTapTimer);
          this._singleTapTimer = null;
          this._lastTapTime = 0;
          this.togglePageZoom(pageWrap, e.clientX);
          return;
        }

        const tapX = e.clientX;
        this._lastTapTime = now;
        this._lastTapX = tapX;
        this._lastTapY = e.clientY;
        clearTimeout(this._singleTapTimer);
        this._singleTapTimer = setTimeout(() => {
          this._singleTapTimer = null;
          if (this.readerSettings?.tapZones !== false) {
            const ratioX = tapX / Math.max(1, window.innerWidth);
            if (ratioX < 0.25) {
              if (this.isSinglePageMode()) {
                this.stepReaderPage(this.readerSettings.mode === 'single-rtl' ? 1 : -1);
              } else {
                window.scrollBy({ top: -Math.round(window.innerHeight * 0.82), behavior: 'smooth' });
              }
              return;
            }
            if (ratioX > 0.75) {
              if (this.isSinglePageMode()) {
                this.stepReaderPage(this.readerSettings.mode === 'single-rtl' ? -1 : 1);
              } else {
                window.scrollBy({ top: Math.round(window.innerHeight * 0.82), behavior: 'smooth' });
              }
              return;
            }
          }
          this.toggleReaderUI();
        }, 260);
      });
    }

    // Reader page scrubber
    const readerScrubber = document.getElementById('reader-scrubber');
    if (readerScrubber) {
      const startScrub = () => {
        clearTimeout(this._scrubUnlockTimer);
        this._isScrubbing = true;
      };
      const scheduleUnlockScrub = (targetPage) => {
        clearTimeout(this._scrubUnlockTimer);
        this._scrubUnlockTimer = setTimeout(() => {
          if (targetPage) {
            this.goToReaderPage(targetPage);
          }
          this._isScrubbing = false;
          this.updateReaderProgressBar();
          this.saveReadingProgress(false);
        }, 250);
      };
      readerScrubber.addEventListener('pointerdown', startScrub);
      readerScrubber.addEventListener('touchstart', startScrub, { passive: true });
      readerScrubber.addEventListener('mousedown', startScrub);
      readerScrubber.addEventListener('pointerup', () => scheduleUnlockScrub(Number(readerScrubber.value) || 1));
      readerScrubber.addEventListener('pointercancel', () => scheduleUnlockScrub(Number(readerScrubber.value) || 1));
      readerScrubber.addEventListener('touchend', () => scheduleUnlockScrub(Number(readerScrubber.value) || 1));
      readerScrubber.addEventListener('mouseup', () => scheduleUnlockScrub(Number(readerScrubber.value) || 1));

      readerScrubber.addEventListener('input', (e) => {
        clearTimeout(this._scrubUnlockTimer);
        this._isScrubbing = true;
        const page = Number(e.target.value) || 1;
        this.goToReaderPage(page);
      });

      readerScrubber.addEventListener('change', (e) => {
        const page = Number(e.target.value) || 1;
        this.goToReaderPage(page);
        scheduleUnlockScrub(page);
      });
    }

    // Modal overlay click to close
    document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        this.closeModal();
      }
    });

    document.getElementById('category-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        this.closeCategoryModal();
      }
    });

    document.getElementById('story-category-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        this.closeStoryCategoryModal();
      }
    });

    document.getElementById('backup-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        this.closeBackupModal();
      }
    });

    // Batch folder input & upload area
    const batchFolderInput = document.getElementById('batch-folder-input');
    batchFolderInput?.addEventListener('change', (e) => {
      this.handleBatchFolderSelect(e.target.files);
      e.target.value = '';
    });

    const batchUploadArea = document.getElementById('batch-upload-area');
    batchUploadArea?.addEventListener('click', () => {
      batchFolderInput?.click();
    });

    document.getElementById('batch-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        this.closeBatchModal();
      }
    });

    document.getElementById('hitomi-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        this.closeHitomiModal();
      }
    });

    // Mobile back gesture / hardware back button support
    window.addEventListener('popstate', (e) => {
      const readerScreen = document.getElementById('screen-reader');
      if (readerScreen && readerScreen.classList.contains('active')) {
        this.exitReader(false);
      }
    });

    // Keyboard escape & single-page arrow navigation
    document.addEventListener('keydown', (e) => {
      const readerScreen = document.getElementById('screen-reader');
      const isReaderActive = readerScreen && readerScreen.classList.contains('active');

      if (e.key === 'Escape') {
        if (isReaderActive) {
          this.exitReader();
          return;
        }
        this.closeModal();
        this.closeCategoryModal();
        this.closeStoryCategoryModal();
        this.closeBackupModal();
        this.closeBatchModal();
        this.closeHitomiModal();
        return;
      }

      if (isReaderActive && this.isSinglePageMode() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        e.preventDefault();
        if (e.key === 'ArrowLeft') {
          this.stepReaderPage(this.readerSettings.mode === 'single-rtl' ? 1 : -1);
        } else {
          this.stepReaderPage(this.readerSettings.mode === 'single-rtl' ? -1 : 1);
        }
      }
    });
    // Save reading progress & re-acquire wake lock on visibility change
    document.addEventListener('visibilitychange', () => {
      const readerScreen = document.getElementById('screen-reader');
      if (!readerScreen || !readerScreen.classList.contains('active')) return;
      if (document.visibilityState === 'hidden') {
        this.saveReadingProgress(true);
      } else if (document.visibilityState === 'visible') {
        this.requestWakeLock();
      }
    });
  }

  // ==================== UTILS ====================
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML.replace(/"/g, '&quot;');
  }
}

// ==================== INIT ====================
const app = new KhoTruyen();
document.addEventListener('DOMContentLoaded', () => app.init());
