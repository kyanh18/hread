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
    this.isStoragePersisted = false;
    this.storageEstimate = { usage: 0, quota: 0, percent: 0 };
    this.hitomiProxyUrl = localStorage.getItem('khotruyen_hitomi_proxy') || '';
    this.hitomiScannedGalleries = [];
    this.hitomiSelectedGalleryIds = new Set();
    this.hitomiAbortController = null;
    this.hitomiScannedTitle = '';
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
  async loadLibrary() {
    this.categories = await this.db.getAllCategories();
    const allStories = await this.db.getAllStories();

    // Sort by last updated
    allStories.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

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
    const filtered = this.searchTerm
      ? storiesToShow.filter((s) => s.name.toLowerCase().includes(this.searchTerm.toLowerCase()))
      : storiesToShow;

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
      .map(
        (story) => `
      <div class="story-card" data-id="${story.id}" onclick="app.openStory('${story.id}')" oncontextmenu="event.preventDefault(); app.showStoryMenu('${story.id}')">
        <div class="story-cover">
          ${
            story.coverData
              ? `<img src="${story.coverData}" alt="${story.name}" loading="lazy">`
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
              🖼 ${story.imageCount || 0}
            </span>
          </div>
        </div>
      </div>
    `
      )
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
  async openStory(storyId) {
    const story = await this.db.getStory(storyId);
    if (!story) return;

    const images = await this.db.getImagesByStory(storyId);
    if (images.length === 0) {
      this.showToast('Truyện chưa có ảnh!', 'error');
      return;
    }

    // Remember library scroll position and current story ID before reading
    this.lastLibraryScrollY = window.scrollY;
    this.lastViewedStoryId = storyId;

    // Push history state so mobile back gesture/button returns to library naturally
    if (!history.state || history.state.screen !== 'reader') {
      history.pushState({ screen: 'reader', storyId }, '');
    }

    this.revokeManagedUrls();
    this.currentStory = story;
    this.readerUIVisible = true;

    // Set header
    document.getElementById('reader-title').textContent = story.name;
    document.getElementById('reader-total').textContent = images.length;
    document.getElementById('reader-current').textContent = '1';

    // Render images with lazy loading, async decoding, and managed URLs
    const content = document.getElementById('reader-content');
    content.innerHTML = images
      .map(
        (img, idx) => `
      <img src="${this.createManagedUrl(img.data)}" alt="Trang ${idx + 1}" data-page="${idx + 1}" loading="lazy" decoding="async">
    `
      )
      .join('');

    // Show reader
    this.showScreen('reader');

    // Update reader header/footer visibility
    document.getElementById('reader-header').classList.remove('hidden');
    document.getElementById('reader-footer').classList.remove('hidden');

    // Setup scroll tracking
    this.setupReaderScroll(images.length);
  }

  setupReaderScroll(totalPages) {
    const content = document.getElementById('reader-content');
    const progressBar = document.getElementById('reader-progress');
    const currentEl = document.getElementById('reader-current');

    const updateProgress = () => {
      const scrollTop = window.scrollY;
      const scrollHeight = document.body.scrollHeight - window.innerHeight;
      const progress = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
      progressBar.style.width = `${Math.min(progress, 100)}%`;

      // Calculate current page
      const imgs = content.querySelectorAll('img');
      let currentPage = 1;
      const viewportCenter = scrollTop + window.innerHeight / 2;

      imgs.forEach((img, idx) => {
        const rect = img.getBoundingClientRect();
        const imgTop = rect.top + scrollTop;
        const imgBottom = imgTop + rect.height;
        if (viewportCenter >= imgTop && viewportCenter <= imgBottom) {
          currentPage = idx + 1;
        }
      });

      currentEl.textContent = currentPage;
    };

    // Throttled scroll handler
    let ticking = false;
    const scrollHandler = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          updateProgress();
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', scrollHandler);
    
    // Clean up on screen change
    this._readerScrollHandler = scrollHandler;
  }

  toggleReaderUI() {
    this.readerUIVisible = !this.readerUIVisible;
    const header = document.getElementById('reader-header');
    const footer = document.getElementById('reader-footer');

    if (this.readerUIVisible) {
      header.classList.remove('hidden');
      footer.classList.remove('hidden');
    } else {
      header.classList.add('hidden');
      footer.classList.add('hidden');
    }
  }

  async exitReader(triggerHistoryBack = true) {
    if (triggerHistoryBack && history.state && history.state.screen === 'reader') {
      history.back();
      return;
    }

    if (this._readerScrollHandler) {
      window.removeEventListener('scroll', this._readerScrollHandler);
      this._readerScrollHandler = null;
    }
    this.revokeManagedUrls();
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
    if (card) card.style.display = 'none';
  }

  async exportBackup() {
    try {
      this.showBackupProgress('Đang đọc danh sách truyện & danh mục...', 5);

      const stories = await this.db.getAllStories();
      const categories = await this.db.getAllCategories();

      if (stories.length === 0 && categories.length === 0) {
        this.showToast('Kho truyện đang trống, không có gì để sao lưu!', 'error');
        this.hideBackupProgress();
        return;
      }

      this.showBackupProgress('Đang tổng hợp dữ liệu ảnh...', 10);
      
      const allImages = [];
      let totalImgCount = 0;
      for (const s of stories) {
        totalImgCount += (s.imageCount || 0);
      }

      let processedImgs = 0;
      for (const s of stories) {
        const imgs = await this.db.getImagesByStory(s.id);
        for (const img of imgs) {
          let dataUrl = '';
          if (img.data instanceof Blob) {
            dataUrl = await this.blobToDataUrl(img.data);
          } else {
            dataUrl = img.data; // already string
          }

          allImages.push({
            id: img.id,
            storyId: img.storyId,
            name: img.name,
            data: dataUrl,
            order: img.order,
          });

          processedImgs++;
          const percent = Math.round(10 + (processedImgs / Math.max(1, totalImgCount)) * 75);
          this.showBackupProgress(`Đang xuất ảnh: ${processedImgs} / ${totalImgCount}...`, percent);
        }
      }

      this.showBackupProgress('Đang tạo file sao lưu...', 90);

      const backupData = {
        app: 'KhoTruyen',
        version: 2,
        exportedAt: Date.now(),
        stories: stories,
        categories: categories,
        images: allImages,
      };

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

  async importBackup(file) {
    if (!file) return;

    const mode = document.querySelector('input[name="restore-mode"]:checked')?.value || 'merge';

    try {
      this.showBackupProgress('Đang đọc file sao lưu...', 10);
      const text = await file.text();
      
      this.showBackupProgress('Đang giải mã dữ liệu...', 25);
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('File JSON bị lỗi định dạng!');
      }

      if (!data || data.app !== 'KhoTruyen' || !Array.isArray(data.stories)) {
        throw new Error('File không hợp lệ hoặc không phải bản sao lưu của Kho Truyện!');
      }

      if (mode === 'replace') {
        if (!confirm('Chế độ "Thay thế toàn bộ" sẽ xoá toàn bộ kho truyện hiện tại trước khi nạp dữ liệu mới. Bạn có chắc chắn không?')) {
          this.hideBackupProgress();
          return;
        }
        this.showBackupProgress('Đang xoá dữ liệu cũ...', 35);
        await this.db.clearAllData();
      }

      // Restore categories
      this.showBackupProgress('Đang khôi phục danh mục...', 40);
      if (Array.isArray(data.categories)) {
        for (const cat of data.categories) {
          await this.db.addCategory(cat);
        }
      }

      // Restore stories
      this.showBackupProgress('Đang khôi phục danh sách truyện...', 50);
      for (const story of data.stories) {
        await this.db.addStory(story);
      }

      // Restore images (stored as Blobs for maximum space optimization!)
      const images = Array.isArray(data.images) ? data.images : [];
      let restoredImgs = 0;
      const totalImgs = images.length;

      for (const img of images) {
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
      this.showToast(`Khôi phục thành công ${data.stories.length} truyện ✓`, 'success');

      setTimeout(() => {
        this.closeBackupModal();
      }, 1200);
    } catch (err) {
      console.error('Restore error:', err);
      this.showToast('Lỗi khôi phục: ' + err.message, 'error');
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
    this.hitomiScannedGalleries = [];
    this.hitomiSelectedGalleryIds.clear();
    this.hitomiScannedTitle = '';

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
    if (this.hitomiAbortController) {
      if (!confirm('Quá trình tải đang diễn ra. Bạn có chắc muốn dừng lại không?')) {
        return;
      }
      this.cancelHitomiDownload();
    }
    const modal = document.getElementById('hitomi-modal-overlay');
    if (modal) modal.style.display = 'none';
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
      const res = await fetch(`${this.hitomiProxyUrl}/api/parse?url=${encodeURIComponent(rawUrl)}`);
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

      if (data.type === 'single') {
        this.hitomiScannedGalleries = [data.gallery];
        this.hitomiSelectedGalleryIds.add(data.gallery.id);
        this.hitomiScannedTitle = data.gallery.title;
      } else if (data.type === 'collection') {
        this.hitomiScannedGalleries = data.galleries || [];
        this.hitomiScannedGalleries.forEach((g) => this.hitomiSelectedGalleryIds.add(g.id));
        this.hitomiScannedTitle = data.pageTitle || 'Hitomi Collection';
      }

      if (this.hitomiScannedGalleries.length === 0) {
        this.showToast('Không tìm thấy bộ truyện nào từ link này!', 'error');
        if (previewSec) previewSec.style.display = 'none';
        if (footerBtn) footerBtn.style.display = 'none';
        return;
      }

      this.renderHitomiGalleryList();
      if (previewSec) {
        previewSec.style.display = 'block';
        setTimeout(() => {
          previewSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
      }
      if (footerBtn) footerBtn.style.display = 'inline-flex';

      this.showToast(`Tìm thấy ${this.hitomiScannedGalleries.length} bộ truyện! ✓`, 'success');
    } catch (err) {
      console.error('Hitomi scan error:', err);
      alert('Lỗi khi quét link Hitomi: ' + err.message + '\n\nLưu ý: Đảm bảo bạn đã triển khai Cloudflare Worker và nhập đúng link Worker.');
    } finally {
      if (spinner) spinner.style.display = 'none';
      if (btnText) btnText.textContent = '🔍 Quét link & Lấy danh sách';
      if (scanBtn) scanBtn.disabled = false;
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
    if (startBtn) startBtn.disabled = (count === 0);
    if (footerBtn) footerBtn.disabled = (count === 0);
  }

  renderHitomiGalleryList() {
    const list = document.getElementById('hitomi-gallery-list');
    const summary = document.getElementById('hitomi-preview-summary');
    const subtitle = document.getElementById('hitomi-preview-subtitle');

    if (summary) summary.textContent = `Tìm thấy ${this.hitomiScannedGalleries.length} bộ truyện`;
    if (subtitle) subtitle.textContent = this.hitomiScannedTitle;
    this.updateHitomiSelectionCount();

    if (!list) return;

    list.innerHTML = this.hitomiScannedGalleries
      .map((gallery) => {
        const isSelected = this.hitomiSelectedGalleryIds.has(gallery.id);
        return `
          <div class="hitomi-gallery-item ${isSelected ? 'selected' : ''}" data-id="${gallery.id}" onclick="app.toggleHitomiGallerySelection('${gallery.id}')">
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

  cancelHitomiDownload() {
    if (this.hitomiAbortController) {
      this.hitomiAbortController.abort();
      this.hitomiAbortController = null;
      this.showToast('Đã dừng tải truyện.', 'info');
      const progressCard = document.getElementById('hitomi-progress-card');
      if (progressCard) progressCard.style.display = 'none';
      const startBtn = document.getElementById('hitomi-start-btn');
      const footerBtn = document.getElementById('hitomi-start-btn-footer');
      if (startBtn) startBtn.disabled = false;
      if (footerBtn) footerBtn.disabled = false;
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

    const selectedCatId = document.getElementById('hitomi-category-select')?.value;
    const progressCard = document.getElementById('hitomi-progress-card');
    const statusText = document.getElementById('hitomi-status-text');
    const detailText = document.getElementById('hitomi-detail-status-text');
    const percentText = document.getElementById('hitomi-percent-text');
    const fillEl = document.getElementById('hitomi-progress-fill');
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
    let createdStoryIds = [];
    let detectedArtistName = '';

    try {
      for (let gIdx = 0; gIdx < totalGalleries; gIdx++) {
        if (signal.aborted) break;

        const gItem = selectedGalleries[gIdx];
        if (statusText) statusText.textContent = `[${gIdx + 1}/${totalGalleries}] Đang lấy thông tin: ${gItem.title}...`;
        if (detailText) detailText.textContent = 'Đang phân giải danh sách ảnh...';

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
        let downloadedBlobs = [];

        // 2. Download all images sequentially
        for (let imgIdx = 0; imgIdx < totalImages; imgIdx++) {
          if (signal.aborted) break;

          const imgObj = imagesList[imgIdx];
          const imgPercent = Math.round(((imgIdx + 1) / totalImages) * 100);
          const overallPercent = Math.round(((gIdx + (imgIdx / totalImages)) / totalGalleries) * 100);

          if (statusText) statusText.textContent = `[${gIdx + 1}/${totalGalleries}] ${galleryData.title}`;
          if (detailText) detailText.textContent = `Đang tải trang ${imgIdx + 1} / ${totalImages} (${imgPercent}%)`;
          if (percentText) percentText.textContent = `${overallPercent}%`;
          if (fillEl) fillEl.style.width = `${overallPercent}%`;

          // Download image blob via proxy
          const imgFetchUrl = `${this.hitomiProxyUrl}/api/image?url=${encodeURIComponent(imgObj.url)}&id=${gItem.id}`;
          const imgBlobRes = await fetch(imgFetchUrl, { signal });
          if (!imgBlobRes.ok) {
            throw new Error(`Lỗi tải trang ${imgIdx + 1}: HTTP ${imgBlobRes.status}`);
          }

          const blob = await imgBlobRes.blob();
          downloadedBlobs.push({
            order: imgIdx,
            name: imgObj.name || `Trang ${imgIdx + 1}`,
            data: blob,
          });

          // Save image to IndexedDB
          await this.db.addImage({
            id: this.generateId(),
            storyId: storyId,
            name: imgObj.name || `Trang ${imgIdx + 1}`,
            data: blob,
            order: imgIdx,
          });
        }

        if (signal.aborted) {
          await this.db.deleteStory(storyId);
          break;
        }

        // 3. Create thumbnail cover from 1st image
        let coverData = '';
        if (downloadedBlobs.length > 0) {
          try {
            coverData = await this.generateThumbnail(downloadedBlobs[0].data, 300, 400);
          } catch (e) {
            console.warn('Could not generate cover for hitomi story:', galleryData.title);
          }
        }

        // 4. Save story metadata
        const story = {
          id: storyId,
          name: galleryData.title || gItem.title,
          coverData: coverData,
          imageCount: downloadedBlobs.length,
          createdAt: now + gIdx,
          updatedAt: now + gIdx,
        };

        await this.db.addStory(story);
        createdStoryIds.push(storyId);
        completedGalleries++;
      }

      if (!signal.aborted && completedGalleries > 0) {
        // Handle Category Assignment
        if (selectedCatId === '') {
          // Auto create category by artist name or page title
          const catName = detectedArtistName ? `Tác giả: ${detectedArtistName}` : (this.hitomiScannedTitle || 'Hitomi');
          let cat = this.categories.find((c) => c.name.toLowerCase() === catName.toLowerCase());
          if (!cat) {
            cat = {
              id: 'cat_' + this.generateId(),
              name: catName,
              storyIds: [...createdStoryIds],
              createdAt: Date.now(),
            };
          } else {
            cat.storyIds = Array.from(new Set([...(cat.storyIds || []), ...createdStoryIds]));
            cat.updatedAt = Date.now();
          }
          await this.db.addCategory(cat);
          this.selectedCategoryId = cat.id; // switch view
        } else if (selectedCatId !== '_none_') {
          const cat = this.categories.find((c) => c.id === selectedCatId);
          if (cat) {
            cat.storyIds = Array.from(new Set([...(cat.storyIds || []), ...createdStoryIds]));
            cat.updatedAt = Date.now();
            await this.db.addCategory(cat);
            this.selectedCategoryId = cat.id;
          }
        }

        if (fillEl) fillEl.style.width = '100%';
        if (percentText) percentText.textContent = '100%';
        if (statusText) statusText.textContent = 'Hoàn tất tải về!';
        if (detailText) detailText.textContent = `Đã lưu an toàn ${completedGalleries} bộ truyện vào kho!`;

        this.showToast(`Đã tải thành công ${completedGalleries} bộ truyện vào app ✓`, 'success');

        setTimeout(async () => {
          this.closeHitomiModal();
          await this.loadLibrary();
          await this.updateStorageUI();
        }, 1200);
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
      this.hitomiAbortController = null;
      if (startBtn) startBtn.disabled = false;
      if (footerBtn) footerBtn.disabled = false;
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

    // Reader tap to toggle UI
    document.getElementById('reader-content').addEventListener('click', () => {
      this.toggleReaderUI();
    });

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

    // Keyboard escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const readerScreen = document.getElementById('screen-reader');
        if (readerScreen && readerScreen.classList.contains('active')) {
          this.exitReader();
          return;
        }
        this.closeModal();
        this.closeCategoryModal();
        this.closeStoryCategoryModal();
        this.closeBackupModal();
        this.closeBatchModal();
        this.closeHitomiModal();
      }
    });
  }

  // ==================== UTILS ====================
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// ==================== INIT ====================
const app = new KhoTruyen();
document.addEventListener('DOMContentLoaded', () => app.init());
