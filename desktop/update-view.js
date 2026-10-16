export class UpdateView {
  #api;
  #version;
  #button;
  #status;
  #revision = -1;
  #state;
  #busy = false;

  constructor(api, { version, button, status }) {
    this.#api = api;
    this.#version = version;
    this.#button = button;
    this.#status = status;
    button.addEventListener('click', () => { void this.#activate(); });
  }

  async initialize() {
    this.#api.onUpdate((state) => this.render(state));
    try { this.render(await this.#api.updateState()); }
    catch { this.#version.textContent = '버전 확인 실패'; }
  }

  render(state) {
    if (state.revision < this.#revision) return;
    this.#revision = state.revision;
    this.#state = state;
    this.#version.textContent = `v${state.currentVersion}`;
    const { phase, version, error } = state;
    this.#button.hidden = !['available', 'downloading', 'downloaded', 'installing'].includes(phase);
    this.#button.disabled = this.#busy || ['downloading', 'installing'].includes(phase);
    this.#button.textContent = phase === 'downloading' ? `다운로드 ${Math.floor(state.progress)}%`
      : phase === 'downloaded' ? '재시작 및 설치' : phase === 'installing' ? '서버 종료 및 설치 준비 중…' : `업데이트 v${version}`;
    this.#button.title = phase === 'downloaded' ? '수집 서버를 종료한 뒤 새 버전을 설치하고 앱을 다시 실행합니다.'
      : `v${version} 다운로드${error ? ' 다시 시도' : ''}`;
    this.#status.hidden = !error;
    this.#status.textContent = error || '';
  }

  async #activate() {
    if (this.#busy || !['available', 'downloaded'].includes(this.#state?.phase)) return;
    const install = this.#state.phase === 'downloaded';
    this.#busy = true;
    this.render(this.#state);
    try {
      this.render(await (install ? this.#api.installUpdate() : this.#api.downloadUpdate()));
    } catch (error) {
      this.#state = { ...this.#state, error: error.message };
    } finally {
      this.#busy = false;
      if (this.#state) this.render(this.#state);
    }
  }
}
