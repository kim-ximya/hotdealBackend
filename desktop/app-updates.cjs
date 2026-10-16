const { EventEmitter } = require('node:events');

// Update state is separate from crawler snapshots; never expose provider URLs.
class AppUpdates extends EventEmitter {
  #updater;
  #state;
  #listeners = [];
  #timer;
  #interval;
  #checking;
  #downloading;
  #installing;
  #disposed = false;
  #beforeInstall;
  #installFailed;
  #log;

  constructor({ updater, version, enabled, beforeInstall, installFailed, log = () => {} }) {
    super();
    this.#updater = updater;
    this.#beforeInstall = beforeInstall;
    this.#installFailed = installFailed;
    this.#log = log;
    this.#state = { revision: 0, currentVersion: version, phase: enabled ? 'idle' : 'disabled',
      version: null, progress: 0, error: null };
    if (!enabled) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;
    // Errors may contain HTTP response bodies or signed URLs. Use our messages.
    updater.logger = null;
    const on = (name, listener) => {
      const guarded = (...args) => { if (!this.#disposed) listener(...args); };
      updater.on(name, guarded);
      this.#listeners.push([name, guarded]);
    };
    on('checking-for-update', () => this.#set({ phase: 'checking', error: null }));
    on('update-not-available', () => this.#set({ phase: 'idle', version: null, progress: 0, error: null }));
    on('update-available', (info) => {
      this.#set({ phase: 'available', version: info.version, progress: 0, error: null });
      this.#log('info', `새 앱 버전 ${info.version}을 사용할 수 있습니다.`);
    });
    on('download-progress', ({ percent }) => {
      if (this.#state.phase === 'downloading') this.#set({ progress: Math.max(0, Math.min(100, Number(percent) || 0)) });
    });
    on('update-downloaded', (info) => {
      this.#set({ phase: 'downloaded', version: info.version, progress: 100, error: null });
      this.#log('info', `앱 ${info.version} 다운로드 완료. 업데이트 버튼으로 재시작하여 설치하세요.`);
    });
    on('error', () => this.#fail());
  }

  snapshot() { return { ...this.#state }; }

  #set(value) {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...value, revision: this.#state.revision + 1 };
    this.emit('snapshot', this.snapshot());
  }

  #fail() {
    if (this.#disposed || this.#state.phase === 'disabled' || this.#state.error) return;
    const installing = this.#state.phase === 'installing';
    const error = installing ? '업데이트 설치를 시작하지 못했습니다. 다시 시도하세요.'
      : this.#state.phase === 'downloading' ? '업데이트 다운로드에 실패했습니다. 인터넷 연결을 확인하고 다시 시도하세요.'
      : '업데이트 확인에 실패했습니다. 인터넷 연결 또는 GitHub 릴리즈를 확인하세요.';
    this.#set({ phase: installing ? 'downloaded' : this.#state.version ? 'available' : 'error', error });
    if (installing) this.#installFailed?.();
    this.#log('error', error);
  }

  start({ initialDelay = 10000, interval = 6 * 60 * 60 * 1000 } = {}) {
    if (this.#disposed || this.#state.phase === 'disabled' || this.#timer || this.#interval) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.check(); }, initialDelay);
    this.#interval = setInterval(() => { void this.check(); }, interval);
    this.#timer.unref?.();
    this.#interval.unref?.();
  }

  check() {
    if (this.#checking) return this.#checking;
    if (this.#disposed || !['idle', 'error'].includes(this.#state.phase)) return Promise.resolve(this.snapshot());
    this.#set({ phase: 'checking', error: null });
    this.#checking = Promise.resolve().then(() => this.#updater.checkForUpdates())
      .catch(() => this.#fail()).then(() => this.snapshot()).finally(() => { this.#checking = null; });
    return this.#checking;
  }

  download() {
    if (this.#downloading) return this.#downloading;
    if (this.#disposed || this.#state.phase !== 'available') return Promise.reject(new Error('다운로드할 업데이트가 없습니다.'));
    this.#set({ phase: 'downloading', progress: 0, error: null });
    this.#log('info', `앱 ${this.#state.version} 업데이트를 다운로드합니다.`);
    this.#downloading = Promise.resolve().then(() => this.#updater.downloadUpdate())
      .catch(() => this.#fail()).then(() => this.snapshot()).finally(() => { this.#downloading = null; });
    return this.#downloading;
  }

  install() {
    if (this.#installing) return this.#installing;
    if (this.#disposed || this.#state.phase !== 'downloaded') return Promise.reject(new Error('업데이트 다운로드를 먼저 완료하세요.'));
    this.#set({ phase: 'installing', error: null });
    this.#installing = Promise.resolve().then(async () => {
      await this.#beforeInstall();
      if (!this.#disposed) this.#updater.quitAndInstall(true, true);
    }).catch(() => this.#fail()).then(() => this.snapshot()).finally(() => { this.#installing = null; });
    return this.#installing;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#timer);
    clearInterval(this.#interval);
    for (const [name, listener] of this.#listeners) this.#updater.removeListener(name, listener);
    // A pending request can still emit 'error' during app shutdown.
    if (this.#checking || this.#downloading) this.#updater.once('error', () => {});
    this.removeAllListeners();
  }
}

module.exports = { AppUpdates };
