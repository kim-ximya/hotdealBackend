const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');

class FloatingNotifications {
  #deps;
  #window = null;
  #articles = [];
  #payload = null;
  #timer = null;
  #sequence = 0;
  #disposed = false;
  #hovered = false;
  #drag = null;
  #animation = null;
  #queued = null;
  #page = pathToFileURL(path.join(__dirname, 'notification.html')).href;

  constructor({ BrowserWindow, ipcMain, screen, getMainWindow, showMainWindow, openArticle,
    getSettings, log, setTimer = setTimeout, clearTimer = clearTimeout,
    setAnimationTimer = setTimeout, clearAnimationTimer = clearTimeout, animationNow = () => performance.now() }) {
    this.#deps = { BrowserWindow, ipcMain, screen, getMainWindow, showMainWindow, openArticle, getSettings, log,
      setTimer, clearTimer, setAnimationTimer, clearAnimationTimer, animationNow };
    ipcMain.handle('hotdeal-notification:action', async (event, action, value) => {
      if (!this.#window || event.sender !== this.#window.webContents ||
          event.senderFrame !== this.#window.webContents.mainFrame || event.senderFrame.url !== this.#page) throw new Error('허용되지 않은 요청입니다.');
      try {
        if (action === 'ready') return { ok: true, value: this.#payload };
        if (action === 'close') this.dismiss();
        else if (['drag-start', 'drag-move', 'drag-end'].includes(action)) {
          if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000) throw new Error('드래그 좌표가 올바르지 않습니다.');
          if (action === 'drag-start') this.#startDrag(value);
          else if (action === 'drag-move') this.#moveDrag(value);
          else return { ok: true, value: await this.#finishDrag(value) };
        } else if (action === 'drag-cancel') await this.#finishDrag(0, true);
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
    this.#deps.displayChanged = () => {
      this.#drag = null;
      this.#cancelAnimation();
      this.#position();
      const queued = this.#queued;
      this.#queued = null;
      if (queued) this.show(queued.articles, { test: queued.test });
      this.#armTimer();
    };
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, this.#deps.displayChanged);
  }

  showDemo() {
    this.show([{ id: null, title: '새 핫딜 알림이 이렇게 표시됩니다.', category: '테스트 알림', author: '미리보기' }], { test: true });
  }

  show(articles, { test = false } = {}) {
    const settings = this.#deps.getSettings();
    if (this.#disposed || (!test && !settings.enabled) || !articles.length) return;
    // Let the dismissed batch finish leaving. New arrivals get a fresh window
    // instead of being lost when the outgoing window is destroyed.
    if (this.#animation?.closing) {
      if (test && this.#queued?.test === false) return;
      const previous = this.#queued?.test === test ? this.#queued.articles : [];
      this.#queued = { test, articles: [...new Map([...previous, ...articles].map((article) => [article.id, article])).values()].slice(0, 1000) };
      return;
    }
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
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, maximizable: false, minimizable: false,
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
      this.#cancelAnimation();
      this.#window = null;
      this.#articles = [];
      this.#payload = null;
      this.#hovered = false;
      this.#drag = null;
      this.#cancelTimer();
    });
    win.once('ready-to-show', () => {
      if (this.#window !== win || this.#disposed) return;
      this.#position();
      win.showInactive();
      win.setAlwaysOnTop(true, 'pop-up-menu');
      win.moveTop();
      this.#armTimer();
    });
    win.loadFile(path.join(__dirname, 'notification.html')).catch((error) => {
      if (this.#window === win) this.dismiss();
      this.#deps.log('error', `알림 화면을 열지 못했습니다: ${error.message}`);
    });
  }

  #position() {
    if (!this.#window || this.#window.isDestroyed() || this.#drag || this.#animation) return;
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
    if (this.#window && !this.#hovered && !this.#drag && !this.#animation) this.#timer = this.#deps.setTimer(() => this.dismiss(), 8000);
  }

  #startDrag(screenX) {
    if (this.#drag || this.#animation) throw new Error('알림 이동이 끝난 뒤 다시 드래그하세요.');
    const origin = this.#window.getBounds();
    const { workArea } = this.#deps.screen.getDisplayMatching(origin);
    this.#drag = { origin, startX: screenX, edge: workArea.x + workArea.width, distance: 0 };
    this.#cancelTimer();
  }

  #moveDrag(screenX) {
    if (!this.#drag) throw new Error('드래그가 시작되지 않았습니다.');
    const drag = this.#drag;
    drag.distance = Math.min(drag.origin.width, Math.max(0, screenX - drag.startX));
    this.#window.setBounds({ ...drag.origin, x: drag.origin.x + Math.round(drag.distance) });
  }

  #finishDrag(screenX, cancelled = false) {
    if (!this.#drag) return false;
    if (!cancelled) this.#moveDrag(screenX);
    const drag = this.#drag;
    this.#drag = null;
    // Also allow a short swipe from the right side when the pointer reaches the
    // monitor edge; such a swipe cannot travel 1/4 of the card's width.
    if (!cancelled && (drag.distance >= Math.min(96, drag.origin.width / 4) ||
        (drag.distance >= 12 && screenX >= drag.edge - 2))) {
      return this.#animateTo(drag.edge + 16, true);
    }
    return this.#animateTo(drag.origin.x, false);
  }

  #animateTo(targetX, closing) {
    const win = this.#window;
    const from = win.getBounds();
    this.#cancelTimer();
    if (!closing && from.x === targetX) {
      this.#position();
      this.#armTimer();
      return false;
    }
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const animation = { closing, promise, resolve, timer: null, startedAt: this.#deps.animationNow() };
    this.#animation = animation;
    const duration = closing ? 260 : 300;
    const tick = () => {
      if (this.#animation !== animation) return;
      animation.timer = null;
      if (win !== this.#window || win.isDestroyed()) { this.#cancelAnimation(); return; }
      const progress = Math.min(1, Math.max(0, (this.#deps.animationNow() - animation.startedAt) / duration));
      const eased = 1 - (1 - progress) ** 3;
      win.setBounds({ ...from, x: Math.round(from.x + (targetX - from.x) * eased) });
      if (closing) win.setOpacity(1 - eased);
      if (progress < 1) {
        animation.timer = this.#deps.setAnimationTimer(tick, 16);
        return;
      }
      this.#animation = null;
      if (closing) {
        const queued = this.#queued;
        this.#queued = null;
        this.dismiss();
        resolve(true);
        if (queued) this.show(queued.articles, { test: queued.test });
      } else {
        this.#position();
        this.#armTimer();
        resolve(false);
      }
    };
    // Begin at the release position; the first frame never jumps to the anchor.
    tick();
    return promise;
  }

  #cancelAnimation() {
    const animation = this.#animation;
    if (!animation) return;
    this.#animation = null;
    if (animation.timer !== null) this.#deps.clearAnimationTimer(animation.timer);
    if (this.#window && !this.#window.isDestroyed()) this.#window.setOpacity(1);
    animation.resolve(false);
  }

  dismiss() {
    this.#queued = null;
    this.#cancelAnimation();
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
