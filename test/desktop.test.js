import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, unlink, rmdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerController } from '../desktop/server-controller.js';
import { createServerRuntime } from '../src/server-runtime.js';
import { readServerConfig } from '../src/server-config.js';
import { loadUserAgent } from '../src/browser-settings.js';
import { ArticleStore } from '../src/article-store.js';
import { InterestSettings } from '../desktop/interest-settings.js';

const article = { id: '123', url: 'https://arca.live/b/hotdeal/123', title: '테스트 핫딜', author: '일반 사용자' };
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'hotdeal-desktop-test-'));
  t.after(async () => { for (const file of await readdir(path)) await unlink(join(path, file)); await rmdir(path); });
  return path;
}
function config(path) { return { ...readServerConfig({}, path), port: 0, directory: path }; }

// Exercise the controller protocol against the real runtime/API, with no Chrome or site access.
class TestWorker extends EventEmitter {
  closed = false;
  messages = [];
  constructor(source) { super(); this.source = source; }
  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(async () => {
      const reply = (result, error) => this.emit('message', { type: 'response', requestId: message.requestId, result, error });
      try {
        if (message.action === 'initialize') {
          this.runtime = await createServerRuntime(message.config, { source: this.source,
            log: (level, text) => this.emit('message', { type: 'log', level, message: text }) });
          this.runtime.service.on('collected', ({ articles }) => this.emit('message', { type: 'articles-collected', articles }));
          await this.runtime.start();
          this.emit('message', { type: 'ready', baseUrl: this.runtime.api.baseUrl, status: this.runtime.service.getStatus() });
          reply({ ready: true });
        } else if (message.action === 'shutdown') {
          await this.runtime?.stop(); this.closed = true; reply({ stopped: true }); this.emit('exit', 0);
        } else if (message.action === 'interval') reply(await this.runtime.service.setIntervalSeconds(message.value));
        else if (message.action === 'collect') { void this.runtime.service.collectNow(); reply({ accepted: true }); }
      } catch (error) { reply(undefined, error.message); }
    });
  }
}
async function fixture(t, collect = async () => [article]) {
  const path = await directory(t);
  let closed = 0;
  const workers = [];
  const controller = new ServerController({ config: config(path), spawnWorker: () => {
    const worker = new TestWorker({ collect, close: async () => { closed++; }, getStatus: () => ({ stage: 'idle', running: true }) });
    workers.push(worker); return worker;
  } });
  await controller.initialize();
  t.after(() => controller.stop());
  return { controller, path, workers, closed: () => closed };
}

test('desktop starts one worker, serves persisted JSON, collects immediately and stops its own source', async (t) => {
  let calls = 0;
  const { controller, workers, closed } = await fixture(t, async () => { calls++; return [article]; });
  await Promise.all([controller.start(), controller.start()]);
  assert.equal(workers.length, 1);
  const runtime = workers[0].runtime;
  await runtime.service.collectNow();
  assert.equal(calls, 1);
  const url = controller.snapshot().baseUrl;
  assert.equal((await (await fetch(`${url}/api/articles`)).json()).articles[0].id, '123');
  await controller.collectNow();
  await runtime.service.collectNow();
  assert.equal(calls, 2);
  await controller.stop();
  assert.equal(closed(), 1);
  assert.equal(workers[0].closed, true);
  assert.equal(controller.snapshot().phase, 'stopped');
  await assert.rejects(fetch(`${url}/api/status`));
});

test('desktop persists interval while stopped and running, and UI settings override CLI interval on restart', async (t) => {
  const { controller, path, workers } = await fixture(t);
  await controller.setIntervalSeconds(240);
  assert.equal(JSON.parse(await readFile(join(path, 'settings.json'), 'utf8')).intervalSeconds, 240);
  await assert.rejects(controller.setIntervalSeconds(0));
  await assert.rejects(controller.setIntervalSeconds(1.5));
  await controller.start();
  assert.equal(workers[0].runtime.service.getStatus().intervalSeconds, 240);
  await controller.setIntervalSeconds(75);
  assert.equal(workers[0].runtime.service.getStatus().intervalSeconds, 75);
  await controller.stop();
  await controller.start();
  assert.equal(workers[1].runtime.service.getStatus().intervalSeconds, 75);
  await controller.stop();
  const restored = new ServerController({ config: { ...config(path), intervalOverride: '999' }, spawnWorker: () => { throw new Error('not needed'); } });
  await restored.initialize();
  assert.equal(restored.snapshot().intervalSeconds, 75);
  assert.equal(restored.snapshot().status.articleCount, 1);
});

test('desktop queues stop during startup, aborts in-flight collection and can restart', async (t) => {
  const { controller, workers, closed } = await fixture(t, ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await Promise.all([controller.start(), controller.stop()]);
  assert.equal(controller.snapshot().phase, 'stopped');
  assert.equal(closed(), 1);
  assert.equal(workers[0].runtime.service.getStatus().isCollecting, false);
  await controller.start();
  assert.equal(workers.length, 2);
});

test('external server attaches through HTTP; interval and manual requests work; disconnect leaves server running', async (t) => {
  const path = await directory(t);
  const runtime = await createServerRuntime(config(path), { source: {
    collect: async () => [article], close: async () => {}, getStatus: () => ({ running: true, stage: 'idle' }),
  } });
  await runtime.start();
  t.after(() => runtime.stop());
  const otherPath = await directory(t);
  const controller = new ServerController({ config: { ...config(otherPath), port: Number(new URL(runtime.api.baseUrl).port) }, spawnWorker: () => { throw new Error('must not spawn'); } });
  await controller.initialize();
  t.after(() => controller.stop());
  await controller.start();
  assert.equal(controller.snapshot().owned, false);
  const externalList = await controller.getArticles({ limit: 1 });
  assert.equal(externalList.source, 'api');
  assert.equal(externalList.articles[0].id, '123');
  await assert.rejects(controller.setUserAgent('External/1.0'), /외부 서버/);
  await assert.rejects(readFile(join(otherPath, 'browser-settings.json')), { code: 'ENOENT' });
  await controller.setIntervalSeconds(300);
  assert.equal(runtime.service.getStatus().intervalSeconds, 300);
  await controller.collectNow();
  await controller.stop();
  assert.equal(runtime.service.getStatus().running, true);
  assert.equal((await fetch(`${runtime.api.baseUrl}/api/status`)).status, 200);
  await assert.rejects(readFile(join(otherPath, 'settings.json')), { code: 'ENOENT' });
});

test('desktop preserves corrupt article JSON, reports startup failure and does not launch a browser', async (t) => {
  const path = await directory(t);
  await writeFile(join(path, 'articles.json'), '{broken');
  let spawned = false;
  const controller = new ServerController({ config: config(path), spawnWorker: () => { spawned = true; } });
  await controller.initialize();
  assert.equal(controller.snapshot().phase, 'error');
  await assert.rejects(controller.start(), /기존 파일을 보존/);
  assert.equal(spawned, false);
  assert.equal(await readFile(join(path, 'articles.json'), 'utf8'), '{broken');
});

test('unexpected worker exit is surfaced and session logs stay bounded without touching stored files', async (t) => {
  const { controller, workers, path } = await fixture(t);
  await controller.start();
  await workers[0].runtime.service.collectNow();
  const before = await readFile(join(path, 'articles.json'), 'utf8');
  await workers[0].runtime.stop();
  workers[0].emit('exit', 1);
  assert.equal(controller.snapshot().phase, 'error');
  assert.equal(controller.snapshot().status.running, false);
  for (let i = 0; i < 510; i++) controller.log('info', `log ${i}`);
  assert.equal(controller.snapshot().logs.length, 500);
  controller.clearLogs();
  assert.equal(controller.snapshot().logs.length, 0);
  assert.equal(await readFile(join(path, 'articles.json'), 'utf8'), before);
});

test('runtime shutdown during API startup closes the listener and never starts collecting', async (t) => {
  const path = await directory(t);
  let calls = 0;
  const runtime = await createServerRuntime(config(path), { source: {
    collect: async () => { calls++; return [article]; }, close: async () => {}, getStatus: () => ({ running: false, stage: 'closed' }),
  } });
  await Promise.all([runtime.start(), runtime.stop()]);
  assert.equal(calls, 0);
  assert.equal(runtime.service.getStatus().running, false);
  assert.throws(() => runtime.api.baseUrl, /실행 중이 아닙니다/);
});

test('UI User-Agent persists independently of interval, stays unchanged in a running server and applies on restart', async (t) => {
  const { controller, path, workers } = await fixture(t);
  await controller.setIntervalSeconds(240);
  await controller.setUserAgent('  HotdealCollector/1.0  ');
  assert.equal(controller.snapshot().userAgent, 'HotdealCollector/1.0');
  await controller.start();
  assert.equal(workers[0].runtime.config.userAgent, 'HotdealCollector/1.0');
  await controller.setUserAgent('HotdealCollector/2.0');
  await controller.setIntervalSeconds(75);
  assert.equal(workers[0].runtime.config.userAgent, 'HotdealCollector/1.0');
  assert.equal(await loadUserAgent(join(path, 'browser-settings.json')), 'HotdealCollector/2.0');
  assert.equal(JSON.parse(await readFile(join(path, 'settings.json'), 'utf8')).intervalSeconds, 75);
  await controller.stop();
  await controller.start();
  assert.equal(workers[1].runtime.config.userAgent, 'HotdealCollector/2.0');
  await controller.stop();
  const restored = new ServerController({ config: { ...config(path), userAgentOverride: 'Env/1.0' }, spawnWorker: () => { throw new Error('not needed'); } });
  await restored.initialize();
  assert.equal(restored.snapshot().userAgent, 'HotdealCollector/2.0');
  await controller.setUserAgent('  ');
  await controller.start();
  assert.equal(workers[2].runtime.config.userAgent, '');
  await controller.stop();
});

test('invalid User-Agent input never overwrites saved settings; CLI override is validated and optional', async (t) => {
  const { controller, path } = await fixture(t);
  await controller.setUserAgent('Valid/1.0');
  const settings = join(path, 'browser-settings.json');
  const before = await readFile(settings, 'utf8');
  for (const value of [null, {}, 123, 'bad\r\nHeader: injected', 'bad\tvalue', '한글', 'a'.repeat(1025)]) {
    await assert.rejects(controller.setUserAgent(value), /User-Agent/);
    assert.equal(await readFile(settings, 'utf8'), before);
  }
  assert.equal(await loadUserAgent(settings, 'Env/1.0'), 'Env/1.0');
  assert.equal(await loadUserAgent(settings, ''), '');
  assert.equal(await loadUserAgent(join(path, 'missing.json')), '');
  assert.equal(readServerConfig({ SELENIUM_USER_AGENT: '  Env/1.0  ' }, path).userAgentOverride, 'Env/1.0');
  assert.throws(() => readServerConfig({ SELENIUM_USER_AGENT: 'bad\nvalue' }, path), /User-Agent/);
});

test('invalid saved browser settings block startup and preserve the file', async (t) => {
  const path = await directory(t);
  const file = join(path, 'browser-settings.json');
  await writeFile(file, '{"userAgent":123}');
  let spawned = false;
  const controller = new ServerController({ config: config(path), spawnWorker: () => { spawned = true; } });
  await controller.initialize();
  assert.equal(controller.snapshot().phase, 'error');
  await assert.rejects(controller.start(), /브라우저 설정/);
  assert.equal(spawned, false);
  assert.equal(await readFile(file, 'utf8'), '{"userAgent":123}');
});

test('article list works while stopped, reads fresh saved JSON and paginates newest IDs without collecting', async (t) => {
  let calls = 0;
  const { controller, path } = await fixture(t, async () => { calls++; return [article]; });
  const empty = await controller.getArticles();
  assert.equal(empty.total, 0);
  assert.equal(empty.source, 'file');
  const store = new ArticleStore({ path: join(path, 'articles.json') });
  await store.save(Array.from({ length: 63 }, (_, index) => ({ ...article, id: String(index + 1), url: `https://arca.live/b/hotdeal/${index + 1}` })));
  const first = await controller.getArticles();
  assert.equal(first.total, 63);
  assert.equal(first.returnedCount, 50);
  assert.equal(first.articles[0].id, '63');
  assert.equal(first.articles.at(-1).id, '14');
  const second = await controller.getArticles({ limit: 50, offset: 50 });
  assert.equal(second.returnedCount, 13);
  assert.equal(second.articles[0].id, '13');
  assert.equal(second.articles.at(-1).id, '1');
  await store.save([{ ...article, title: '갱신된 제목' }]);
  assert.equal((await controller.getArticles()).articles[0].title, '갱신된 제목');
  assert.equal(calls, 0);
  assert.equal(controller.snapshot().phase, 'stopped');
});

test('running article queries use the API snapshot, never trigger site collection and remain available after stop', async (t) => {
  let calls = 0;
  const { controller, workers } = await fixture(t, async () => { calls++; return [{ ...article, title: `수집 ${calls}` }]; });
  await controller.start();
  await workers[0].runtime.service.collectNow();
  assert.equal((await controller.getArticles()).source, 'api');
  assert.equal((await controller.getArticles()).articles[0].title, '수집 1');
  assert.equal(calls, 1);
  await controller.collectNow();
  await workers[0].runtime.service.collectNow();
  assert.equal((await controller.getArticles()).articles[0].title, '수집 2');
  assert.equal(calls, 2);
  await controller.stop();
  const saved = await controller.getArticles();
  assert.equal(saved.source, 'file');
  assert.equal(saved.articles[0].title, '수집 2');
});

test('New tags agree across API pages, interest filters and stopped JSON reads without changing original titles', async (t) => {
  const post = (id, title) => ({ ...article, id, url: `https://arca.live/b/hotdeal/${id}`, title });
  let posts = [post('123', 'SSD 기준 글')];
  const { controller, workers } = await fixture(t, async () => posts);
  await controller.start();
  await workers[0].runtime.service.collectNow();
  posts = [post('125', 'SSD 새 글'), post('124', '생수 새 글'), ...posts];
  await workers[0].runtime.service.collectNow();
  assert.equal((await controller.getArticles({ limit: 1, offset: 0 })).articles[0].isNew, true);
  assert.equal((await controller.getArticles({ limit: 1, offset: 1 })).articles[0].isNew, true);
  const filtered = await controller.getArticles({ keywords: ['SSD'] });
  assert.deepEqual(filtered.articles.map(({ id, isNew }) => [id, isNew]), [['125', true], ['123', false]]);
  assert.equal(filtered.articles[0].title, 'SSD 새 글');
  await controller.stop();
  assert.deepEqual((await controller.getArticles({ keywords: ['SSD'] })).articles, filtered.articles);
});

test('article queries reject invalid pagination and report corrupt saved JSON without rewriting it', async (t) => {
  const { controller, path } = await fixture(t);
  for (const query of [null, [], { limit: 0 }, { limit: 1001 }, { limit: '50' }, { offset: -1 }, { offset: 0.5 }, { path: '../secret' }]) {
    await assert.rejects(controller.getArticles(query));
  }
  const file = join(path, 'articles.json');
  await writeFile(file, '{broken');
  await assert.rejects(controller.getArticles(), /기존 파일을 보존/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('new-post events follow successful persistence, exclude the initial list, deduplicate updates and survive restart', async (t) => {
  let posts = [article];
  let fail = false;
  const { controller, workers, path } = await fixture(t, async () => {
    if (fail) throw new Error('site unavailable');
    return posts;
  });
  const events = [];
  controller.on('new-articles', (articles) => events.push(articles));
  await controller.start();
  await workers[0].runtime.service.collectNow();
  assert.equal(events.length, 0);
  const next = { ...article, id: '124', url: 'https://arca.live/b/hotdeal/124', title: '신규 핫딜' };
  posts = [next, { ...article, views: 99 }];
  fail = true;
  await workers[0].runtime.service.collectNow();
  assert.equal(events.length, 0);
  fail = false;
  await workers[0].runtime.service.collectNow();
  assert.deepEqual(events.map((batch) => batch.map(({ id }) => id)), [['124']]);
  assert.equal(JSON.parse(await readFile(join(path, 'articles.json'), 'utf8')).articles[0].id, '124');
  await workers[0].runtime.service.collectNow();
  assert.equal(events.length, 1);
  await controller.stop();
  await controller.start();
  await workers[1].runtime.service.collectNow();
  assert.equal(events.length, 1);
  posts = [{ ...next, id: '125', url: 'https://arca.live/b/hotdeal/125' }, next];
  await workers[1].runtime.service.collectNow();
  assert.deepEqual(events.at(-1).map(({ id }) => id), ['125']);
});

test('interests filter all saved pages before pagination while running and stopped without collecting again', async (t) => {
  let calls = 0;
  const posts = Array.from({ length: 1205 }, (_, i) => ({ ...article, id: String(i + 1),
    url: `https://arca.live/b/hotdeal/${i + 1}`, title: i % 2 ? 'SSD 행사' : '생수 행사' }));
  const { controller, workers } = await fixture(t, async () => { calls++; return posts; });
  await controller.start();
  await workers[0].runtime.service.collectNow();
  const page = await controller.getArticles({ keywords: ['ssd'], limit: 50, offset: 550 });
  assert.equal(page.source, 'api');
  assert.equal(page.total, 602);
  assert.equal(page.allTotal, 1205);
  assert.equal(page.returnedCount, 50);
  assert.equal(page.articles[0].id, '104');
  assert.ok(page.articles.every(({ title }) => title === 'SSD 행사'));
  assert.equal((await controller.getArticles({ keywords: [] })).total, 0);
  assert.equal((await controller.getArticles()).total, 1205);
  assert.equal(calls, 1);
  await controller.stop();
  const saved = await controller.getArticles({ keywords: ['SSD'], limit: 50, offset: 550 });
  assert.equal(saved.source, 'file');
  assert.deepEqual(saved.articles, page.articles);
  await assert.rejects(controller.getArticles({ keywords: [''] }));
});

test('nonmatching new posts advance the watermark so changing interests never replays them as new', async (t) => {
  let posts = [article];
  const { controller, workers, path } = await fixture(t, async () => posts);
  const interests = new InterestSettings(join(path, 'interest-settings.json'));
  await interests.initialize();
  await interests.save({ keywords: ['SSD'], notifyOnlyMatches: true });
  const alerts = [];
  controller.on('new-articles', (batch) => alerts.push(...interests.filterNotifications(batch)));
  await controller.start();
  await workers[0].runtime.service.collectNow();
  posts = [{ ...article, id: '124', url: 'https://arca.live/b/hotdeal/124', title: '생수' }];
  await workers[0].runtime.service.collectNow();
  assert.deepEqual(alerts, []);
  await interests.save({ keywords: ['생수'], notifyOnlyMatches: true });
  await workers[0].runtime.service.collectNow();
  assert.deepEqual(alerts, []);
  posts = [{ ...article, id: '125', url: 'https://arca.live/b/hotdeal/125', title: '생수' }];
  await workers[0].runtime.service.collectNow();
  assert.deepEqual(alerts.map(({ id }) => id), ['125']);
});
