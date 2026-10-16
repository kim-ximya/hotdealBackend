const path = require('node:path');
const { pathToFileURL } = require('node:url');

class LogWindow {
  #deps;
  #window = null;
  #loading = null;
  #loaded = false;
  #visible = false;
  #disposed = false;
  #revision = 0;
  #logs = [];
  #signature = null;
  #listener;
  #page = pathToFileURL(path.join(__dirname, 'logs.html')).href;

  constructor({ BrowserWindow, ipcMain, controller, icon }) {
    this.#deps = { BrowserWindow, ipcMain, controller, icon };
    this.#listener = (snapshot) => {
      const logs = snapshot.logs;
      const signature = `${logs[0]?.id}/${logs.at(-1)?.id}/${logs.length}`;
      if (signature === this.#signature) return;
      this.#signature = signature;
      this.#logs = logs;
      this.#revision++;
      if (this.#loaded && this.#window && !this.#window.isDestroyed()) {
        this.#window.webContents.send('hotdeal-logs:update', this.#snapshot());
      }
    };
    this.#listener(controller.snapshot());
    controller.on('snapshot', this.#listener);
    for (const action of ['read', 'clear']) ipcMain.handle(`hotdeal-logs:${action}`, async (event) => {
      const win = this.#window;
      if (!win || win.isDestroyed() || event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== this.#page) throw new Error('허용되지 않은 요청입니다.');
      try {
        if (action === 'clear') controller.clearLogs();
        return { ok: true, value: this.#snapshot() };
      } catch (error) { return { ok: false, error: error.message }; }
    });
  }

  #snapshot() { return structuredClone({ revision: this.#revision, logs: this.#logs }); }

  #show() {
    const win = this.#window;
    if (!this.#visible || !this.#loaded || !win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  async open() {
    if (this.#disposed) throw new Error('앱이 종료 중입니다.');
    this.#visible = true;
    if (this.#window && !this.#window.isDestroyed()) { this.#show(); return this.#loading; }
    const win = new this.#deps.BrowserWindow({ width: 960, height: 660, minWidth: 660, minHeight: 420,
      title: '실행 로그 · 핫딜 수집 관리자', icon: this.#deps.icon, backgroundColor: '#0c111b', show: false,
      webPreferences: { preload: path.join(__dirname, 'logs-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.#window = win;
    this.#loaded = false;
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('render-process-gone', () => win.destroy());
    win.on('closed', () => {
      if (this.#window !== win) return;
      this.#window = null; this.#loaded = false; this.#loading = null;
    });
    const loading = Promise.resolve().then(() => win.loadFile(path.join(__dirname, 'logs.html'))).then(() => {
      if (this.#window !== win || win.isDestroyed()) return;
      this.#loaded = true;
      win.webContents.send('hotdeal-logs:update', this.#snapshot());
      this.#show();
    }).catch((error) => {
      if (this.#window !== win || win.isDestroyed()) return;
      win.destroy();
      throw error;
    });
    this.#loading = loading;
    return loading;
  }

  hide() { this.#visible = false; if (this.#window && !this.#window.isDestroyed()) this.#window.hide(); }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#visible = false;
    this.#deps.controller.off('snapshot', this.#listener);
    for (const action of ['read', 'clear']) this.#deps.ipcMain.removeHandler(`hotdeal-logs:${action}`);
    if (this.#window && !this.#window.isDestroyed()) this.#window.destroy();
  }
}

module.exports = { LogWindow };
