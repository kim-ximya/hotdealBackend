import { Builder } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArticleList, SOURCE_URL } from './article-parser.js';
import { normalizeUserAgent } from './browser-settings.js';

export function createChromeOptions({ directory, chromeBinary, userAgent = '' }) {
  const options = new chrome.Options();
  options.addArguments('--headless=new', `--user-data-dir=${resolve(directory, 'profile')}`, '--window-size=1200,900');
  const normalized = normalizeUserAgent(userAgent);
  if (normalized) options.addArguments(`--user-agent=${normalized}`);
  if (chromeBinary) options.setChromeBinaryPath(chromeBinary);
  return options;
}

function inspectDocument() {
  const table = document.querySelector('.article-list .list-table');
  const navigation = performance.getEntriesByType('navigation')[0];
  return {
    title: document.title,
    hasArticleList: Boolean(table),
    challengeDetected: /just a moment|잠시만/i.test(document.title) || Boolean(document.querySelector('#challenge-running, #cf-challenge-running, #challenge-stage')),
    httpStatus: navigation?.responseStatus > 0 ? navigation.responseStatus : null,
    url: location.origin + location.pathname,
  };
}

export class SeleniumCollector {
  #directory;
  #waitSeconds;
  #binary;
  #userAgent;
  #driver = null;
  #building = null;
  #closed = false;
  #status = { headless: true, stage: 'idle', running: false, version: null, effectiveUserAgent: null, title: null, httpStatus: null, attentionRequired: false };

  constructor({ directory, waitSeconds = 120, chromeBinary, userAgent = '' }) {
    this.#directory = directory;
    this.#waitSeconds = waitSeconds;
    this.#binary = chromeBinary;
    this.#userAgent = normalizeUserAgent(userAgent);
  }

  getStatus() { return { ...this.#status, userAgent: this.#userAgent }; }

  async #getDriver() {
    if (this.#closed) throw new Error('브라우저 수집기가 종료되었습니다.');
    if (this.#driver) return this.#driver;
    if (!this.#building) {
      this.#building = (async () => {
        this.#status.stage = 'starting-browser';
        await mkdir(this.#directory, { recursive: true });
        process.env.SE_CACHE_PATH = resolve(this.#directory, 'driver-cache');
        process.env.SE_AVOID_STATS = 'true';
        process.env.SE_AVOID_BROWSER_DOWNLOAD = 'true';
        process.env.SE_TIMEOUT = '60';
        const options = createChromeOptions({ directory: this.#directory, chromeBinary: this.#binary, userAgent: this.#userAgent });
        this.#driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
        this.#status.running = true;
        this.#status.version = (await this.#driver.getCapabilities()).get('browserVersion');
        await this.#driver.manage().setTimeouts({ pageLoad: 30_000, script: 10_000, implicit: 0 });
        this.#status.effectiveUserAgent = await this.#driver.executeScript('return navigator.userAgent');
        return this.#driver;
      })().finally(() => { this.#building = null; });
    }
    return this.#building;
  }

  async collect({ signal } = {}) {
    try {
      signal?.throwIfAborted();
      const driver = await this.#getDriver();
      signal?.throwIfAborted();
      this.#status.stage = 'navigating';
      try {
        await driver.get(SOURCE_URL);
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
      }
      const deadline = Date.now() + this.#waitSeconds * 1000;
      for (;;) {
        signal?.throwIfAborted();
        const state = await driver.executeScript(inspectDocument);
        this.#status.title = state.title;
        this.#status.httpStatus = state.httpStatus;
        this.#status.attentionRequired = state.challengeDetected;
        if (state.hasArticleList && !state.challengeDetected && state.url === SOURCE_URL) {
          this.#status.stage = 'parsing';
          const articles = parseArticleList(await driver.getPageSource());
          this.#status.stage = 'idle';
          this.#status.attentionRequired = false;
          return articles;
        }
        this.#status.stage = 'waiting-for-list';
        if (Date.now() >= deadline) {
          const detail = state.challengeDetected
            ? '사이트 보안 확인이 감지되었습니다. 헤드리스 모드에서는 직접 확인할 수 없습니다.'
            : '접속 상태나 사이트 HTML 구조를 확인하세요.';
          throw new Error(`게시글 목록을 ${this.#waitSeconds}초 동안 확인하지 못했습니다. ${detail} (페이지: ${state.title}, HTTP: ${state.httpStatus ?? '알 수 없음'})`);
        }
        await delay(1000, undefined, { signal });
      }
    } catch (error) {
      this.#status.stage = this.#closed ? 'closed' : 'error';
      // Recover a closed/crashed browser on the next scheduled attempt, without retrying navigation here.
      if (['NoSuchSessionError', 'InvalidSessionIdError', 'NoSuchWindowError', 'SessionNotCreatedError'].includes(error.name) || /ECONNREFUSED|chrome not reachable|disconnected: not connected to DevTools/i.test(error.message)) {
        const driver = this.#driver;
        this.#driver = null;
        this.#status.running = false;
        if (driver) await driver.quit().catch(() => {});
      }
      throw error;
    }
  }

  async close() {
    this.#closed = true;
    if (this.#building) await this.#building.catch(() => {});
    const driver = this.#driver;
    this.#driver = null;
    if (driver) await driver.quit().catch(() => {});
    this.#status.running = false;
    this.#status.stage = 'closed';
    this.#status.attentionRequired = false;
  }
}
