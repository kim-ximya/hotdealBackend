const path = require('node:path');
const { pathToFileURL } = require('node:url');

class FloatingNotifications {
  #deps;
  #window = null;
  #articles = [];
  #payload = null;
  #timer = null;
  #sequence = 0;
  #disposed = false;
  #hovered = false;
  #page = pathToFileURL(path.join(__dirname, 'notification.html')).href;

  constructor({ BrowserWindow, ipcMain, screen, getMainWindow, showMainWindow, openArticle,
    getSettings, log, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.#deps = { BrowserWindow, ipcMain, screen, getMainWindow, showMainWindow, openArticle, getSettings, log, setTimer, clearTimer };
    ipcMain.handle('hotdeal-notification:action', async (event, action, value) => {
      if (!this.#window || event.sender !== this.#window.webContents ||
          event.senderFrame !== this.#window.webContents.mainFrame || event.senderFrame.url !== this.#page) throw new Error('허용되지 않은 요청입니다.');
      try {
        if (action === 'ready') return { ok: true, value: this.#payload };
        if (action === 'close') this.dismiss();
        else if (action === 'hover' && typeof value === 'boolean') {
          this.#hovered = value;
          if (value) this.#cancelTimer(); else this.#armTimer();
        } else if (action === 'list') { showMainWindow(); this.dismiss(); }
        else if (action === 'article' && typeof value === 'string' && this.#articles.some(({ id }) => id === value)) {
          await openArticle(value);
          this.dismiss();
        } else throw new Error('알림 요청이 올바르지 않습니다.');
        return { ok: true };
      } catch (error) { return { ok: false, error: error.message }; }
    });
    this.#deps.displayChanged = () => this.#position();
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, this.#deps.displayChanged);
  }

  showDemo() {
    this.show([{ id: null, title: '새 핫딜 알림이 이렇게 표시됩니다.', category: '테스트 알림', author: '미리보기' }], { test: true });
  }

  show(articles, { test = false } = {}) {
    const settings = this.#deps.getSettings();
    if (this.#disposed || (!test && !settings.enabled) || !articles.length) return;
    if (!this.#window || this.#payload?.test !== test) this.#articles = [];
    this.#articles = [...new Map([...this.#articles, ...articles].map((article) => [article.id, article])).values()]
      .sort((a, b) => a.id === null || b.id === null ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0).slice(0, 1000);
    this.#payload = { sequence: ++this.#sequence, test, total: this.#articles.length,
      articles: this.#articles.slice(0, 3), sound: settings.soundEnabled };
    if (this.#window && !this.#window.isDestroyed()) {
      this.#position();
      this.#window.webContents.send('hotdeal-notification:update', this.#payload);
      if (this.#window.isVisible()) this.#window.moveTop();
      this.#armTimer();
      return;
    }
    const win = new this.#deps.BrowserWindow({
      width: 396, height: 240, title: '새 핫딜 알림', show: false,
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
      fullscreenable: false, alwaysOnTop: true, skipTaskbar: true,
      webPreferences: { preload: path.join(__dirname, 'notification-preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
    });
    this.#window = win;
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('render-process-gone', () => this.dismiss());
    win.on('closed', () => {
      if (this.#window !== win) return;
      this.#window = null;
      this.#articles = [];
      this.#payload = null;
      this.#hovered = false;
      this.#cancelTimer();
    });
    win.once('ready-to-show', () => {
      if (this.#window !== win || this.#disposed) return;
      this.#position();
      win.showInactive();
      win.moveTop();
      this.#armTimer();
    });
    win.loadFile(path.join(__dirname, 'notification.html')).catch((error) => {
      if (this.#window === win) this.dismiss();
      this.#deps.log('error', `알림 화면을 열지 못했습니다: ${error.message}`);
    });
  }

  #position() {
    if (!this.#window || this.#window.isDestroyed()) return;
    const main = this.#deps.getMainWindow();
    const display = main && !main.isDestroyed()
      ? this.#deps.screen.getDisplayMatching(main.getBounds()) : this.#deps.screen.getPrimaryDisplay();
    const area = display.workArea;
    const width = Math.min(396, area.width);
    const height = Math.min(150 + (this.#payload?.articles.length || 1) * 76, area.height);
    this.#window.setBounds({ width, height,
      x: area.x + Math.max(0, area.width - width - 16), y: area.y + Math.max(0, area.height - height - 16) });
  }

  #cancelTimer() {
    if (this.#timer !== null) this.#deps.clearTimer(this.#timer);
    this.#timer = null;
  }

  #armTimer() {
    this.#cancelTimer();
    if (this.#window && !this.#hovered) this.#timer = this.#deps.setTimer(() => this.dismiss(), 8000);
  }

  dismiss() {
    this.#cancelTimer();
    if (this.#window && !this.#window.isDestroyed()) this.#window.destroy();
  }

  dispose() {
    this.#disposed = true;
    this.dismiss();
    this.#deps.ipcMain.removeHandler('hotdeal-notification:action');
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) this.#deps.screen.removeListener(event, this.#deps.displayChanged);
  }
}

module.exports = { FloatingNotifications };
