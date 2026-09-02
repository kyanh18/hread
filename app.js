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
    this.bindEvents();
    this.showScreen('library');
    this.loadLibrary();
    this.registerSW();
  }

  registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  // ==================== NAVIGATION ====================
  showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    const screen = document.getElementById(`screen-${name}`);
    if (screen) {
      screen.classList.add('active');
      screen.style.animation = 'none';
      screen.offsetHeight; // trigger reflow
      screen.style.animation = '';
    }

    // Reset scroll
    window.scrollTo(0, 0);
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
    if (this.selectedCategoryId === 'all') {
      statsEl.innerHTML = `
        <div class="stat-badge">
          <span class="stat-num">${allStories.length}</span> truyện
        </div>
        <div class="stat-badge">
          <span class="stat-num">${totalImages}</span> ảnh
        </div>
      `;
    } else {
      statsEl.innerHTML = `
        <div class="stat-badge">
          <span class="stat-num">${storiesToShow.length}</span> / ${allStories.length} truyện
        </div>
        <div class="stat-badge">
          <span class="stat-num">${this.categories.length}</span> danh mục
        </div>
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
    this.loadLibrary();
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
    this.loadLibrary();
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

  exitReader() {
    if (this._readerScrollHandler) {
      window.removeEventListener('scroll', this._readerScrollHandler);
      this._readerScrollHandler = null;
    }
    this.revokeManagedUrls();
    const content = document.getElementById('reader-content');
    if (content) content.innerHTML = '';
    this.showScreen('library');
    this.loadLibrary();
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
  openBackupModal() {
    const modal = document.getElementById('backup-modal-overlay');
    if (modal) modal.style.display = 'flex';
    this.hideBackupProgress();
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

    // Keyboard escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeModal();
        this.closeCategoryModal();
        this.closeStoryCategoryModal();
        this.closeBackupModal();
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
