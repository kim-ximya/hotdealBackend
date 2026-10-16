import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { ArticleStore, atomicWriteJson } from '../src/article-store.js';
import { loadInterval, validInterval } from '../src/crawl-service.js';
import { loadUserAgent, normalizeUserAgent } from '../src/browser-settings.js';
import { NewArticleTracker } from './new-article-tracker.js';
import { normalizeKeywords, selectArticles } from '../src/interests.js';

export class ServerController extends EventEmitter {
  #config;
  #spawn;
  #fetch;
  #child = null;
  #exit = null;
  #pending = new Map();
  #serial = Promise.resolve();
  #poll = null;
  #requestId = 0;
  #logId = 0;
  #state;
  #articleTracker = new NewArticleTracker();
  #externalArticlesAt = null;
  #pollBusy = false;
  #generation = 0;

  constructor({ config, spawnWorker, fetchImpl = fetch }) {
    super();
    this.#config = { ...config, intervalOverride: undefined, userAgentOverride: undefined };
    this.#spawn = spawnWorker;
    this.#fetch = fetchImpl;
    this.#state = { phase: 'stopped', owned: false, baseUrl: null, error: null,
      dataDirectory: config.directory, intervalSeconds: 180, userAgent: '', status: null, logs: [] };
  }

  async initialize() {
    try {
      this.#state.intervalSeconds = await loadInterval(resolve(this.#config.directory, 'settings.json'));
      this.#state.userAgent = await loadUserAgent(resolve(this.#config.directory, 'browser-settings.json'));
      const store = new ArticleStore({ path: resolve(this.#config.directory, 'articles.json'), maxArticles: this.#config.maxArticles });
      await store.load();
      const saved = store.getSnapshot();
      this.#state.status = { articleCount: saved.total, lastSuccessAt: saved.updatedAt, running: false,
        intervalSeconds: this.#state.intervalSeconds, browser: { stage: 'closed', running: false } };
      this.log('info', '준비되었습니다. 서버를 시작하면 첫 수집이 실행됩니다.');
    } catch (error) {
      this.#state.phase = 'error';
      this.#state.error = error.message;
      this.log('error', error.message);
    }
    return this.snapshot();
  }

  snapshot() { return structuredClone(this.#state); }
  #publish() { this.emit('snapshot', this.snapshot()); }
  log(level, message) {
    this.#state.logs.push({ id: ++this.#logId, at: new Date().toISOString(), level, message: String(message).slice(0, 8000) });
    if (this.#state.logs.length > 500) this.#state.logs.splice(0, this.#state.logs.length - 500);
    this.#publish();
  }
  clearLogs() { this.#state.logs = []; this.#publish(); }
  async getArticles(query = {}) {
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some((key) => !['limit', 'offset', 'keywords'].includes(key))) throw new Error('목록 조회 조건이 올바르지 않습니다.');
    const { limit = 50, offset = 0 } = query;
    const keywords = query.keywords === undefined ? undefined : normalizeKeywords(query.keywords);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('limit는 1~1000, offset은 0 이상의 정수여야 합니다.');
    if (this.#state.phase === 'running') {
      if (keywords !== undefined) {
        const snapshot = await this.#readAllArticles();
        return { ...selectArticles(snapshot, { limit, offset, keywords }), source: 'api' };
      }
      return { ...await this.#http(`/api/articles?limit=${limit}&offset=${offset}`), source: 'api' };
    }
    const store = new ArticleStore({ path: resolve(this.#config.directory, 'articles.json'), maxArticles: this.#config.maxArticles });
    await store.load();
    const snapshot = store.getSnapshot();
    return { ...selectArticles(snapshot, { limit, offset, keywords }), source: 'file' };
  }

  async #readAllArticles() {
    // Read the full saved API snapshot before filtering, including older external
    // servers that only understand limit/offset. Reads never request a crawl.
    const first = await this.#http('/api/articles?limit=1000&offset=0');
    if (!Array.isArray(first.articles) || !Number.isSafeInteger(first.total) || first.total < 0 || first.total > 100000) throw new Error('게시글 목록 응답이 올바르지 않습니다.');
    const articles = [...first.articles];
    if (articles.length !== Math.min(1000, first.total)) throw new Error('게시글 페이지 크기가 올바르지 않습니다.');
    while (articles.length < first.total) {
      const page = await this.#http(`/api/articles?limit=1000&offset=${articles.length}`);
      if (page.updatedAt !== first.updatedAt || page.total !== first.total) throw new Error('목록이 갱신되었습니다. 목록 새로고침을 눌러 다시 시도하세요.');
      if (!Array.isArray(page.articles) || page.articles.length !== Math.min(1000, first.total - articles.length)) throw new Error('게시글 페이지 크기가 올바르지 않습니다.');
      articles.push(...page.articles);
    }
    return { ...first, articles };
  }
  #queue(action) {
    const task = this.#serial.then(action);
    this.#serial = task.catch(() => {});
    return task;
  }
  #updateStatus(status) {
    this.#state.status = status;
    this.#state.intervalSeconds = status.intervalSeconds;
    this.#publish();
  }

  async #http(path, options) {
    const response = await this.#fetch(`${this.#state.baseUrl}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  start() { return this.#queue(async () => {
    if (this.#state.phase === 'running') return this.snapshot();
    if (this.#child) throw new Error('이전 서버의 종료를 먼저 완료하세요.');
    this.#generation++;
    this.#externalArticlesAt = null;
    this.#state.phase = 'starting';
    this.#state.error = null;
    this.#publish();
    try {
      // Validate saved files on every start, preserving corrupt files for recovery.
      const store = new ArticleStore({ path: resolve(this.#config.directory, 'articles.json'), maxArticles: this.#config.maxArticles });
      await store.load();
      const baseline = store.getSnapshot();
      this.#articleTracker = new NewArticleTracker(baseline.updatedAt ? baseline.articles : null);
      await loadInterval(resolve(this.#config.directory, 'settings.json'));
      this.#state.userAgent = await loadUserAgent(resolve(this.#config.directory, 'browser-settings.json'));
      if (this.#config.port) {
        this.#state.baseUrl = `http://127.0.0.1:${this.#config.port}`;
        let existing;
        try { existing = await this.#http('/api/status'); } catch { /* No compatible server yet. */ }
        if (existing?.mode === 'selenium' && existing.channel === '/b/hotdeal' &&
            existing.running === true && validInterval(existing.intervalSeconds)) {
          this.#state.phase = 'running';
          this.#state.owned = false;
          // The attached server may use a different data folder: seed from its API.
          const baseline = await this.#http('/api/articles?limit=1000&offset=0');
          this.#articleTracker = new NewArticleTracker(baseline.updatedAt ? baseline.articles : null);
          this.#externalArticlesAt = baseline.updatedAt;
          this.#updateStatus(existing);
          this.log('info', '별도로 실행 중인 서버에 연결했습니다. 연결 해제 시 해당 서버는 계속 실행됩니다.');
          this.#poll = setInterval(() => { void this.#pollExternal(); }, 1500);
          return this.snapshot();
        }
      }
      const child = this.#spawn();
      this.#child = child;
      this.#state.owned = true;
      this.#exit = new Promise((resolveExit) => child.once('exit', (code) => {
        this.#child = null;
        for (const pending of this.#pending.values()) pending.reject(new Error('서버 프로세스가 종료되었습니다.'));
        this.#pending.clear();
        if (this.#state.phase !== 'stopping') {
          this.#state.phase = 'error';
          this.#state.error = `서버 프로세스가 예기치 않게 종료되었습니다 (코드 ${code}).`;
          this.log('error', this.#state.error);
        }
        this.#markStoppedStatus();
        resolveExit(code);
      }));
      child.on('message', (message) => this.#onMessage(message));
      for (const stream of [child.stdout, child.stderr]) {
        let buffer = '';
        stream?.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop().slice(-8000);
          for (const line of lines) if (line.trim()) this.log('browser', line.trim());
        });
      }
      await this.#request('initialize', { config: this.#config }, 90000);
      this.#state.phase = 'running';
      this.#publish();
      return this.snapshot();
    } catch (error) {
      this.#state.phase = 'error';
      this.#state.error = error.message;
      this.log('error', `서버 시작 실패: ${error.message}`);
      throw error;
    }
  }); }

  async #pollExternal() {
    if (this.#pollBusy || this.#state.owned || this.#state.phase !== 'running') return;
    this.#pollBusy = true;
    const generation = this.#generation;
    try {
      const previous = this.#state.status;
      const status = await this.#http('/api/status');
      if (generation !== this.#generation || this.#state.phase !== 'running' || this.#state.owned) return;
      this.#updateStatus(status);
      if (status.lastSuccessAt && status.lastSuccessAt !== previous?.lastSuccessAt) this.log('info', `외부 서버 수집 완료: 총 보관 ${status.articleCount}개`);
      if (status.lastError?.at !== previous?.lastError?.at && status.lastError) this.log('error', status.lastError.message);
      if (status.lastSuccessAt && status.lastSuccessAt !== this.#externalArticlesAt) {
        try {
          const snapshot = await this.#http('/api/articles?limit=1000&offset=0');
          if (generation !== this.#generation || this.#state.phase !== 'running' || this.#state.owned) return;
          this.#announceArticles(snapshot.articles);
          this.#externalArticlesAt = snapshot.updatedAt;
        } catch (error) {
          if (generation === this.#generation && this.#state.phase === 'running') this.log('error', `외부 서버 새 글 확인 실패: ${error.message}`);
        }
      }
    } catch (error) {
      if (generation !== this.#generation || this.#state.phase !== 'running' || this.#state.owned) return;
      clearInterval(this.#poll);
      this.#poll = null;
      this.#state.phase = 'error';
      this.#state.error = `외부 서버 연결 끊김: ${error.message}`;
      this.#markStoppedStatus();
      this.log('error', this.#state.error);
    } finally { this.#pollBusy = false; }
  }

  #announceArticles(articles) {
    const added = this.#articleTracker.observe(articles);
    if (added.length) this.emit('new-articles', added);
  }

  #onMessage(message) {
    if (message.type === 'articles-collected' && this.#state.owned && ['starting', 'running'].includes(this.#state.phase)) this.#announceArticles(message.articles);
    if (message.type === 'log') this.log(message.level, message.message);
    if (message.type === 'status') this.#updateStatus(message.status);
    if (message.type === 'ready') {
      this.#state.baseUrl = message.baseUrl;
      this.#updateStatus(message.status);
    }
    if (message.type === 'response') {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      this.#pending.delete(message.requestId);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    }
  }
  #request(action, payload = {}, timeout = 15000) {
    return new Promise((resolveRequest, reject) => {
      const requestId = ++this.#requestId;
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error('서버 응답 시간이 초과되었습니다. 상태를 확인한 뒤 다시 시도하세요.'));
      }, timeout);
      const finish = (callback) => (value) => { clearTimeout(timer); callback(value); };
      this.#pending.set(requestId, { resolve: finish(resolveRequest), reject: finish(reject) });
      try { this.#child.postMessage({ type: 'command', action, requestId, ...payload }); }
      catch (error) { this.#pending.get(requestId)?.reject(error); this.#pending.delete(requestId); }
    });
  }
  #markStoppedStatus() {
    if (this.#state.status) this.#state.status = { ...this.#state.status, running: false, isCollecting: false,
      nextRunAt: null, browser: { ...this.#state.status.browser, stage: 'closed', running: false, attentionRequired: false } };
    this.#publish();
  }

  stop() { return this.#queue(async () => {
    this.#generation++;
    clearInterval(this.#poll);
    this.#poll = null;
    this.#state.phase = 'stopping';
    this.#publish();
    if (this.#child) {
      try {
        await this.#request('shutdown', {}, 90000);
        await this.#exit;
      } catch (error) {
        this.#state.phase = 'error';
        this.#state.error = error.message;
        this.log('error', `종료 실패: ${error.message}`);
        throw error;
      }
      this.log('info', '서버와 전용 Chrome을 종료했습니다.');
    } else if (!this.#state.owned && this.#state.baseUrl) this.log('info', '외부 서버 연결을 해제했습니다. 해당 서버는 계속 실행됩니다.');
    this.#state.phase = 'stopped';
    this.#state.owned = false;
    this.#state.baseUrl = null;
    this.#state.error = null;
    this.#markStoppedStatus();
    return this.snapshot();
  }); }

  setIntervalSeconds(value) { return this.#queue(async () => {
    if (!validInterval(value)) throw new Error('수집 간격은 1초~24시간 사이의 정수 초여야 합니다.');
    if (this.#state.phase === 'running') {
      if (this.#state.owned) await this.#request('interval', { value });
      else await this.#http('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalSeconds: value }) });
    } else {
      if (this.#child) throw new Error('서버 종료를 먼저 완료하세요.');
      await atomicWriteJson(resolve(this.#config.directory, 'settings.json'), { intervalSeconds: value });
    }
    this.#state.intervalSeconds = value;
    if (this.#state.status) this.#state.status.intervalSeconds = value;
    this.log('info', `수집 간격을 ${value}초로 저장했습니다.`);
    return this.snapshot();
  }); }

  setUserAgent(value) { return this.#queue(async () => {
    if (this.#state.phase === 'running' && !this.#state.owned) throw new Error('외부 서버에 연결된 상태에서는 User-Agent를 변경할 수 없습니다.');
    if (['starting', 'stopping'].includes(this.#state.phase)) throw new Error('서버 시작·종료가 완료된 뒤 변경하세요.');
    const userAgent = normalizeUserAgent(value);
    await atomicWriteJson(resolve(this.#config.directory, 'browser-settings.json'), { userAgent });
    this.#state.userAgent = userAgent;
    this.log('info', `User-Agent 설정 저장: ${userAgent ? '사용자 지정' : 'Chrome 기본값'}. 다음 서버 시작부터 적용합니다.`);
    return this.snapshot();
  }); }

  collectNow() { return this.#queue(async () => {
    if (this.#state.phase !== 'running') throw new Error('서버를 먼저 시작하세요.');
    if (this.#state.owned) await this.#request('collect');
    else await this.#http('/api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    this.log('info', '즉시 수집을 요청했습니다. 진행 중인 수집이 있으면 해당 작업에 합류합니다.');
    return this.snapshot();
  }); }
}
