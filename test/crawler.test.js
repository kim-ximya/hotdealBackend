import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, unlink, rmdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { ArticleStore, atomicWriteJson } from '../src/article-store.js';
import { CrawlService, loadInterval } from '../src/crawl-service.js';
import { CrawlerApi } from '../src/crawler-api.js';
import { readServerConfig } from '../src/server-config.js';

const article = (id, overrides = {}) => ({
  id, url: `https://arca.live/b/hotdeal/${id}`, title: `핫딜 ${id}`, author: '일반 작성자',
  category: '게임', createdAt: '2026-10-13T00:00:00Z', views: 10, recommendations: 0, commentCount: 0,
  isNotice: false, ...overrides,
});
const settle = () => new Promise(setImmediate);

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hotdeal-crawler-test-'));
  t.after(async () => {
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  });
  return directory;
}

function source(collect = async () => [article('1')]) {
  return { collect, close: async () => {}, getStatus: () => ({ running: true, stage: 'idle' }) };
}

function clock() {
  let now = Date.parse('2026-10-13T01:00:00Z');
  const timers = new Map();
  let sequence = 0;
  return {
    timers, now: () => now, advance: (milliseconds) => { now += milliseconds; },
    setTimer(callback, milliseconds) { const id = ++sequence; timers.set(id, { callback, at: now + milliseconds }); return id; },
    clearTimer(id) { timers.delete(id); },
    async fireNext() {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(id);
      now = timer.at;
      timer.callback();
      await settle();
    },
  };
}

async function serviceFixture(t, { collect, intervalSeconds = 180, storeOptions = {} } = {}) {
  const directory = await temporary(t);
  const store = new ArticleStore({ path: join(directory, 'articles.json'), ...storeOptions });
  await store.load();
  const timer = clock();
  const browser = source(collect);
  const settingsPath = join(directory, 'settings.json');
  const service = new CrawlService({ source: browser, store, intervalSeconds, settingsPath, ...timer });
  t.after(() => service.stop());
  return { directory, store, browser, settingsPath, timer, service };
}

test('JSON store merges by ID, preserves firstSeenAt, sorts newest IDs first and reloads from disk', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'articles.json');
  const store = new ArticleStore({ path });
  await store.load();
  const firstTime = '2026-10-13T01:00:00Z';
  const secondTime = '2026-10-13T01:03:00Z';
  await store.save([article('10'), article('9')], firstTime);
  const result = await store.save([article('11'), article('10', { views: 20 })], secondTime);
  assert.equal(result.addedCount, 1);
  assert.equal(result.collectedCount, 2);
  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.articles.map(({ id }) => id), ['11', '10', '9']);
  assert.equal(snapshot.articles[1].firstSeenAt, firstTime);
  assert.equal(snapshot.articles[1].lastSeenAt, secondTime);
  assert.equal(snapshot.articles[1].views, 20);
  assert.equal(snapshot.total, 3);
  const restored = new ArticleStore({ path });
  await restored.load();
  assert.deepEqual(restored.getSnapshot(), snapshot);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), snapshot);
  assert.deepEqual(await readdir(directory), ['articles.json']);
});

test('New tags mark the initial batch, persist on unchanged collections and move together when new posts arrive', async (t) => {
  const directory = await temporary(t);
  const store = new ArticleStore({ path: join(directory, 'articles.json') });
  const flagged = () => store.getSnapshot().articles.filter(({ isNew }) => isNew).map(({ id }) => id);
  await store.save([article('10'), article('9')]);
  assert.deepEqual(flagged(), ['10', '9']);
  await store.save([article('10', { views: 99, title: '수정된 원본 제목' })]);
  assert.deepEqual(flagged(), ['10', '9']);
  await store.save([article('12'), article('11'), article('10')]);
  assert.deepEqual(flagged(), ['12', '11']);
  assert.equal(store.getSnapshot().articles.find(({ id }) => id === '9').isNew, false);
  await store.save([article('9', { isNew: true }), article('12', { isNew: false })]);
  assert.deepEqual(flagged(), ['12', '11']);
  assert.equal(store.getSnapshot().articles[0].title, '핫딜 12');
});

test('discarded or staff posts never rotate New tags; retention contains only committed new posts', async (t) => {
  const directory = await temporary(t);
  const store = new ArticleStore({ path: join(directory, 'articles.json'), maxArticles: 2 });
  const flagged = () => store.getSnapshot().articles.filter(({ isNew }) => isNew).map(({ id }) => id);
  await store.save([article('10'), article('9')]);
  await store.save([article('11')]);
  assert.deepEqual(flagged(), ['11']);
  await store.save([article('8'), article('12', { author: '*운영진' })]);
  assert.deepEqual(flagged(), ['11']);
  await store.save([article('12'), article('13'), article('14')]);
  assert.deepEqual(flagged(), ['14', '13']);
  assert.deepEqual(store.getSnapshot().articles.map(({ id }) => id), ['14', '13']);
});

test('legacy JSON starts without New tags and new-batch flags survive reload and failed persistence', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'articles.json');
  const original = new ArticleStore({ path });
  await original.save([article('10')]);
  const legacy = original.getSnapshot();
  delete legacy.articles[0].isNew;
  await writeFile(path, JSON.stringify(legacy));
  let fail = false;
  const store = new ArticleStore({ path, write: async (...args) => {
    if (fail) throw new Error('disk full');
    await atomicWriteJson(...args);
  } });
  await store.load();
  assert.equal(store.getSnapshot().articles[0].isNew, false);
  await store.save([article('10')]);
  assert.equal(store.getSnapshot().articles[0].isNew, false);
  await store.save([article('11')]);
  const before = store.getSnapshot();
  const diskBefore = await readFile(path, 'utf8');
  fail = true;
  await assert.rejects(store.save([article('12')]), /disk full/);
  assert.deepEqual(store.getSnapshot(), before);
  assert.equal(await readFile(path, 'utf8'), diskBefore);
  const restored = new ArticleStore({ path });
  await restored.load();
  assert.deepEqual(restored.getSnapshot(), before);
  assert.deepEqual(before.articles.filter(({ isNew }) => isNew).map(({ id }) => id), ['11']);
});

test('retention keeps newest IDs and staff authors are excluded even when updating an existing record', async (t) => {
  const directory = await temporary(t);
  const store = new ArticleStore({ path: join(directory, 'articles.json'), maxArticles: 2 });
  await store.save([article('1'), article('3'), article('2'), article('4', { author: '*운영진' })]);
  assert.deepEqual(store.getSnapshot().articles.map(({ id }) => id), ['3', '2']);
  await store.save([article('3', { author: '*ㅎㅎ' })]);
  assert.deepEqual(store.getSnapshot().articles.map(({ id }) => id), ['2']);
});

test('failed atomic persistence does not publish a new snapshot or overwrite the previous JSON', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'articles.json');
  let fail = false;
  const store = new ArticleStore({ path, write: async (...args) => {
    if (fail) throw new Error('disk full');
    await atomicWriteJson(...args);
  } });
  await store.save([article('1')]);
  const before = store.getSnapshot();
  const diskBefore = await readFile(path, 'utf8');
  fail = true;
  await assert.rejects(store.save([article('2')]), /disk full/);
  assert.deepEqual(store.getSnapshot(), before);
  assert.equal(await readFile(path, 'utf8'), diskBefore);
});

test('collection events include only committed retained rows and never announce a failed save', async (t) => {
  let fail = false;
  const { service, store } = await serviceFixture(t, {
    collect: async () => [article('2'), article('3'), article('4', { author: '*운영진' })],
    storeOptions: { maxArticles: 1, write: async (...args) => {
      if (fail) throw new Error('disk full');
      await atomicWriteJson(...args);
    } },
  });
  const events = [];
  service.on('collected', (event) => events.push(event));
  fail = true;
  assert.equal((await service.collectNow()).ok, false);
  assert.equal(events.length, 0);
  assert.equal(store.getSnapshot().total, 0);
  fail = false;
  assert.equal((await service.collectNow()).ok, true);
  assert.deepEqual(events[0].articles.map(({ id }) => id), ['3']);
  assert.deepEqual(events[0].articles, store.getSnapshot().articles);
});

test('corrupt stored JSON fails safely without rewriting the file', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'articles.json');
  await writeFile(path, '{broken json');
  await assert.rejects(new ArticleStore({ path }).load(), /기존 파일을 보존/);
  assert.equal(await readFile(path, 'utf8'), '{broken json');
});

test('startup collects immediately then uses the default three-minute cadence', async (t) => {
  let calls = 0;
  const { service, timer } = await serviceFixture(t, { collect: async () => [article(String(++calls))] });
  service.start();
  await service.collectNow();
  assert.equal(calls, 1);
  assert.equal(service.getStatus().intervalSeconds, 180);
  assert.equal(service.getStatus().nextRunAt, '2026-10-13T01:03:00.000Z');
  assert.equal(timer.timers.size, 1);
  await timer.fireNext();
  await service.collectNow();
  assert.equal(calls, 2);
  assert.equal(service.getStatus().successes, 2);
});

test('concurrent collection requests coalesce and long-running work skips missed ticks', async (t) => {
  let release;
  let calls = 0;
  const { service, timer } = await serviceFixture(t, { collect: () => {
    calls++;
    return new Promise((resolve) => { release = resolve; });
  } });
  service.start();
  const first = service.collectNow();
  const second = service.collectNow();
  assert.equal(first, second);
  await settle();
  assert.equal(calls, 1);
  assert.equal(timer.timers.size, 0);
  timer.advance(220000);
  release([article('1')]);
  await first;
  assert.equal(service.getStatus().nextRunAt, '2026-10-13T01:06:00.000Z');
  assert.equal(timer.timers.size, 1);
});

test('interval changes persist and take effect after in-flight work without creating another collector', async (t) => {
  let release;
  const { service, settingsPath, timer } = await serviceFixture(t, { collect: () => new Promise((resolve) => { release = resolve; }) });
  service.start();
  const collection = service.collectNow();
  await settle();
  await service.setIntervalSeconds(60);
  assert.equal(service.getStatus().intervalSeconds, 60);
  assert.equal(timer.timers.size, 0);
  release([article('1')]);
  await collection;
  assert.equal(service.getStatus().nextRunAt, '2026-10-13T01:01:00.000Z');
  assert.equal(await loadInterval(settingsPath), 60);
  assert.equal(await loadInterval(settingsPath, '90'), 90);
  await assert.rejects(service.setIntervalSeconds(0), /intervalSeconds/);
  assert.equal(await loadInterval(settingsPath), 60);
});

test('failed collection preserves stored data, exposes the error and succeeds on a later scheduled run', async (t) => {
  let fail = false;
  const { service, store, timer } = await serviceFixture(t, { collect: async () => {
    if (fail) throw new Error('browser disconnected');
    return [article('1')];
  } });
  service.start();
  await service.collectNow();
  const before = store.getSnapshot();
  fail = true;
  assert.equal((await service.collectNow()).ok, false);
  assert.deepEqual(store.getSnapshot(), before);
  assert.match(service.getStatus().lastError.message, /browser disconnected/);
  assert.equal(service.getStatus().consecutiveFailures, 1);
  assert.equal(timer.timers.size, 1);
  fail = false;
  await timer.fireNext();
  await service.collectNow();
  assert.equal(service.getStatus().lastError, null);
  assert.equal(service.getStatus().consecutiveFailures, 0);
});

test('stopping cancels waiting collection, closes its source and never schedules another attempt', async (t) => {
  let closed = false;
  const { service, browser, timer, store } = await serviceFixture(t, { collect: ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  browser.close = async () => { closed = true; };
  service.start();
  await settle();
  await service.stop();
  assert.equal(closed, true);
  assert.equal(service.getStatus().running, false);
  assert.equal(service.getStatus().isCollecting, false);
  assert.equal(service.getStatus().lastError, null);
  assert.equal(timer.timers.size, 0);
  assert.equal(store.getSnapshot().updatedAt, null);
  assert.equal((await service.collectNow()).stopped, true);
});

test('config defaults and persisted interval load are validated before launching Chrome', async (t) => {
  const directory = await temporary(t);
  const config = readServerConfig({}, directory);
  assert.equal(config.port, 38471);
  assert.equal(config.directory, resolve(directory, '.local/selenium-server'));
  assert.equal(await loadInterval(join(directory, 'absent.json')), 180);
  for (const override of ['0', '', 'abc', '86401']) await assert.rejects(loadInterval(join(directory, 'absent.json'), override));
  assert.throws(() => readServerConfig({ PORT: 'abc' }, directory));
  assert.throws(() => readServerConfig({ MAX_ARTICLES: '0' }, directory));
  assert.throws(() => readServerConfig({ SELENIUM_WAIT_SECONDS: '' }, directory));
});

test('HTTP API serves saved JSON, paginates it and persists interval changes without fetching on reads', async (t) => {
  let calls = 0;
  const { service, store, settingsPath } = await serviceFixture(t, { collect: async () => {
    calls++;
    return [article('1'), article('3'), article('2')];
  } });
  service.start();
  await service.collectNow();
  const api = new CrawlerApi({ service, store, port: 0, allowedOrigins: ['http://localhost:5173'] });
  await api.start();
  t.after(() => api.stop());
  const list = await (await fetch(`${api.baseUrl}/api/articles?limit=1&offset=1`)).json();
  assert.equal(list.total, 3);
  assert.equal(list.returnedCount, 1);
  assert.equal(list.articles[0].id, '2');
  assert.equal((await (await fetch(`${api.baseUrl}/api/status`)).json()).successes, 1);
  assert.equal(calls, 1);
  const change = await fetch(`${api.baseUrl}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"intervalSeconds":75}' });
  assert.equal(change.status, 200);
  assert.equal((await (await fetch(`${api.baseUrl}/api/settings`)).json()).intervalSeconds, 75);
  assert.equal(await loadInterval(settingsPath), 75);
  const cors = await fetch(`${api.baseUrl}/api/articles`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const manual = await fetch(`${api.baseUrl}/api/collect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(manual.status, 202);
  await service.collectNow();
  assert.equal(calls, 2);
});

test('API rejects invalid settings, untrusted origins, foreign Hosts and oversized bodies', async (t) => {
  const { service, store } = await serviceFixture(t);
  const api = new CrawlerApi({ service, store, port: 0 });
  await api.start();
  t.after(() => api.stop());
  const put = (body, headers = {}) => fetch(`${api.baseUrl}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body });
  for (const body of ['{"intervalSeconds":0}', '{"intervalSeconds":"180"}', '{bad', 'null', '{"intervalSeconds":30,"other":true}']) {
    assert.equal((await put(body)).status, 400);
  }
  assert.equal((await put('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await put('x'.repeat(5000))).status, 413);
  assert.equal((await put('{"intervalSeconds":10}', { Origin: 'https://other.example' })).status, 403);
  assert.equal((await fetch(`${api.baseUrl}/api/status`, { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await fetch(`${api.baseUrl}/api/articles?limit=0`)).status, 400);
  assert.equal((await fetch(`${api.baseUrl}/api/articles?offset=1.5`)).status, 400);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(`${api.baseUrl}/api/status`, { headers: { Host: 'other.example' } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(status, 403);
  assert.equal(service.getStatus().attempts, 0);
});
