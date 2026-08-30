/* ====================================================================
   KHO TRUYỆN - Offline Vertical Comic Reader
   ==================================================================== */

// ==================== DATABASE ====================
class StoryDB {
  constructor() {
    this.dbName = 'KhoTruyenDB';
    this.dbVersion = 1;
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
    
    return this._transaction('stories', 'readwrite', (store) => store.delete(id));
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
    const stories = await this.db.getAllStories();
    const filtered = this.searchTerm
      ? stories.filter((s) => s.name.toLowerCase().includes(this.searchTerm.toLowerCase()))
      : stories;

    // Sort by last updated
    filtered.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

    // Update stats
    const statsEl = document.getElementById('library-stats');
    const totalImages = stories.reduce((sum, s) => sum + (s.imageCount || 0), 0);
    statsEl.innerHTML = `
      <div class="stat-badge">
        <span class="stat-num">${stories.length}</span> truyện
      </div>
      <div class="stat-badge">
        <span class="stat-num">${totalImages}</span> ảnh
      </div>
    `;

    // Render grid
    const grid = document.getElementById('story-grid');
    
    if (filtered.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📚</div>
          <h3>${this.searchTerm ? 'Không tìm thấy' : 'Chưa có truyện nào'}</h3>
          <p>${this.searchTerm ? 'Thử tìm kiếm với từ khác' : 'Nhấn nút + để tạo truyện mới\nvà bắt đầu bộ sưu tập của bạn!'}</p>
        </div>
      `;
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

  // ==================== CREATE / EDIT ====================
  openCreate() {
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

    this.currentStory = story;
    const images = await this.db.getImagesByStory(storyId);
    this.editImages = images.map((img) => ({
      id: img.id,
      name: img.name,
      data: img.data,
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
        <img class="image-thumb" src="${img.data}" alt="Trang ${idx + 1}">
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
      const data = await this.readFileAsDataURL(file);
      this.editImages.push({
        id: this.generateId(),
        name: file.name,
        data: data,
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

  async generateThumbnail(dataUrl, maxW, maxH) {
    return new Promise((resolve) => {
      const img = new Image();
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
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.src = dataUrl;
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

    this.currentStory = story;
    this.readerUIVisible = true;

    // Set header
    document.getElementById('reader-title').textContent = story.name;
    document.getElementById('reader-total').textContent = images.length;
    document.getElementById('reader-current').textContent = '1';

    // Render images
    const content = document.getElementById('reader-content');
    content.innerHTML = images
      .map(
        (img, idx) => `
      <img src="${img.data}" alt="Trang ${idx + 1}" data-page="${idx + 1}">
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
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        this.closeModal();
      }
    });

    // Keyboard escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = document.getElementById('modal-overlay');
        if (modal.style.display === 'flex') {
          this.closeModal();
        }
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
