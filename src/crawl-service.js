import { EventEmitter } from 'node:events';
import { atomicWriteJson } from './article-store.js';
import { readFile } from 'node:fs/promises';

export function validInterval(value) {
  return Number.isInteger(value) && value >= 1 && value <= 86400;
}

export async function loadInterval(path, override) {
  if (override !== undefined) {
    const value = Number(override);
    if (!validInterval(value)) throw new Error('CRAWL_INTERVAL_SECONDS는 1~86400 사이의 정수여야 합니다.');
    return value;
  }
  try {
    const settings = JSON.parse(await readFile(path, 'utf8'));
    if (!validInterval(settings.intervalSeconds)) throw new Error('저장된 수집 간격이 올바르지 않습니다.');
    return settings.intervalSeconds;
  } catch (error) {
    if (error.code === 'ENOENT') return 180;
    throw error;
  }
}

export class CrawlService extends EventEmitter {
  #source;
  #store;
  #intervalSeconds;
  #settingsPath;
  #settingsTail = Promise.resolve();
  #setTimer;
  #clearTimer;
  #now;
  #timer = null;
  #inFlight = null;
  #abort = null;
  #active = false;
  #stopping = false;
  #nextRunAt = null;
  #lastStartedAt = null;
  #lastFinishedAt = null;
  #lastSuccessAt = null;
  #lastError = null;
  #attempts = 0;
  #successes = 0;
  #consecutiveFailures = 0;

  constructor({ source, store, intervalSeconds = 180, settingsPath,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    super();
    if (!validInterval(intervalSeconds)) throw new Error('수집 간격은 1~86400초 사이의 정수여야 합니다.');
    this.#source = source;
    this.#store = store;
    this.#intervalSeconds = intervalSeconds;
    this.#settingsPath = settingsPath;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#now = now;
    this.#lastSuccessAt = store.getSnapshot().updatedAt;
  }

  start() {
    if (this.#active || this.#stopping) return;
    this.#active = true;
    void this.collectNow();
  }

  getStatus() {
    return {
      mode: 'selenium', channel: '/b/hotdeal',
      intervalSeconds: this.#intervalSeconds,
      isCollecting: this.#inFlight !== null,
      running: this.#active,
      nextRunAt: this.#nextRunAt,
      lastStartedAt: this.#lastStartedAt,
      lastFinishedAt: this.#lastFinishedAt,
      lastSuccessAt: this.#lastSuccessAt,
      lastError: this.#lastError,
      attempts: this.#attempts, successes: this.#successes, consecutiveFailures: this.#consecutiveFailures,
      articleCount: this.#store.getSnapshot().total,
      browser: this.#source.getStatus(),
    };
  }

  #cancelTimer() {
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#nextRunAt = null;
  }

  #schedule() {
    this.#cancelTimer();
    if (!this.#active || this.#stopping || this.#inFlight) return;
    const now = this.#now();
    const intervalMs = this.#intervalSeconds * 1000;
    const lastStart = this.#lastStartedAt ? Date.parse(this.#lastStartedAt) : now;
    // Skip elapsed ticks rather than running missed jobs back to back.
    const next = lastStart + Math.max(1, Math.floor((now - lastStart) / intervalMs) + 1) * intervalMs;
    this.#nextRunAt = new Date(next).toISOString();
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.collectNow();
    }, next - now);
  }

  collectNow() {
    if (this.#stopping) return Promise.resolve({ ok: false, stopped: true });
    if (this.#inFlight) return this.#inFlight;
    this.#cancelTimer();
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    this.#lastStartedAt = new Date(this.#now()).toISOString();
    this.#attempts++;
    this.#inFlight = Promise.resolve().then(async () => {
      this.emit('collectionStarted', { startedAt: this.#lastStartedAt });
      const articles = await this.#source.collect({ signal });
      signal.throwIfAborted();
      const result = await this.#store.save(articles, new Date(this.#now()).toISOString());
      this.#lastSuccessAt = result.updatedAt;
      this.#lastError = null;
      this.#successes++;
      this.#consecutiveFailures = 0;
      // Announce only rows retained in the committed JSON, including when the
      // retention limit is smaller than a single fetched page.
      const collectedIds = new Set(articles.map(({ id }) => id));
      this.emit('collected', { ...result, articles: this.#store.getSnapshot().articles.filter(({ id }) => collectedIds.has(id)) });
      return { ok: true, ...result };
    }).catch((error) => {
      if (this.#stopping && signal.aborted) return { ok: false, stopped: true };
      this.#lastError = { message: error.message, at: new Date(this.#now()).toISOString() };
      this.#consecutiveFailures++;
      this.emit('collectionFailed', this.#lastError);
      return { ok: false, error: this.#lastError };
    }).finally(() => {
      this.#lastFinishedAt = new Date(this.#now()).toISOString();
      this.#inFlight = null;
      this.#abort = null;
      this.#schedule();
    });
    return this.#inFlight;
  }

  setIntervalSeconds(value) {
    if (!validInterval(value)) return Promise.reject(new Error('intervalSeconds는 1~86400 사이의 정수여야 합니다.'));
    const update = this.#settingsTail.then(async () => {
      if (this.#stopping) throw new Error('서버가 종료 중입니다.');
      await atomicWriteJson(this.#settingsPath, { intervalSeconds: value });
      this.#intervalSeconds = value;
      this.#schedule();
      this.emit('intervalChanged', { intervalSeconds: value });
      return { intervalSeconds: value };
    });
    this.#settingsTail = update.catch(() => {});
    return update;
  }

  async stop() {
    this.#stopping = true;
    this.#active = false;
    this.#cancelTimer();
    this.#abort?.abort();
    await this.#source.close();
    if (this.#inFlight) await this.#inFlight;
    await this.#settingsTail;
  }
}
