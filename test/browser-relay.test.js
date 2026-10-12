import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, unlink, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserRelay, loadRelayToken } from '../src/browser-relay.js';

const TOKEN = 'test_token_'.repeat(4);
const fixture = await readFile(new URL('./fixtures/hotdeal-list.html', import.meta.url), 'utf8');
const hybridFixture = await readFile(new URL('./fixtures/hotdeal-hybrid.html', import.meta.url), 'utf8');
const event = (overrides = {}) => ({
  type: 'na', channel: '/b/hotdeal', socketState: 'receiving',
  clientId: 'test-tab', eventId: 'test-tab:1', receivedAt: '2026-10-12T09:00:00.000Z',
  ...overrides,
});

async function start(t) {
  const relay = new BrowserRelay({ token: TOKEN, port: 0 });
  await relay.start();
  t.after(() => relay.stop());
  return relay;
}

const post = (relay, body, headers = {}) => fetch(`${relay.baseUrl}/api/relay`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('installation embeds local configuration; public status does not expose the token', async (t) => {
  const relay = await start(t);
  const status = await (await fetch(`${relay.baseUrl}/api/status`)).json();
  assert.equal(status.browserOnline, false);
  assert.equal(status.socketReceiving, false);
  assert.equal(status.newArticleCount, 0);
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
  const root = await (await fetch(relay.baseUrl)).text();
  assert.match(root, /hotdeal-relay\.user\.js/);
  assert.equal(root.includes(TOKEN), false);
  const response = await fetch(`${relay.baseUrl}/hotdeal-relay.user.js`);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const source = await response.text();
  assert.ok(source.includes(TOKEN));
  assert.ok(source.includes(`${relay.baseUrl}/api/relay`));
  assert.equal(source.includes('/*__RELAY_CONFIG__*/ null'), false);
});

test('only na emits newArticle; retries are deduplicated and status tracks socket state', async (t) => {
  const relay = await start(t);
  const notifications = [];
  relay.on('newArticle', (data) => notifications.push(data));
  const states = [
    ['ready', 'waiting'], ['subscribed', 'subscribed'], ['heartbeat', 'receiving'],
    ['na', 'receiving'], ['disconnected', 'closed'],
  ];
  for (const [index, [type, socketState]] of states.entries()) {
    const response = await post(relay, event({ type, socketState, eventId: `test-tab:${index}` }));
    assert.equal(response.status, 200);
  }
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].channel, '/b/hotdeal');
  assert.equal(notifications[0].browserReceivedAt, event().receivedAt);
  assert.ok(Number.isFinite(Date.parse(notifications[0].receivedAt)));
  const duplicate = await post(relay, event({ eventId: 'test-tab:3' }));
  assert.deepEqual(await duplicate.json(), { ok: true, duplicate: true });
  assert.equal(notifications.length, 1);
  assert.equal(relay.getStatus().browserOnline, true);
  assert.equal(relay.getStatus().socketReceiving, false);
  assert.equal(relay.getStatus().newArticleCount, 1);
  assert.equal(relay.getStatus().clients[0].socketState, 'closed');
});

test('heartbeat status expires after 45 seconds and client history is bounded', async (t) => {
  const relay = await start(t);
  for (let index = 0; index < 17; index++) {
    const response = await post(relay, event({ type: 'heartbeat', clientId: `tab-${index}`, eventId: `tab-${index}:1` }));
    assert.equal(response.status, 200);
  }
  assert.equal(relay.getStatus().clients.length, 16);
  assert.equal(relay.getStatus().clients[0].clientId, 'tab-1');
  const lastSeen = Date.parse(relay.getStatus().clients.at(-1).lastSeenAt);
  t.mock.method(Date, 'now', () => lastSeen + 45_001);
  assert.equal(relay.getStatus().browserOnline, false);
  assert.equal(relay.getStatus().socketReceiving, false);
});

test('authentication, content type, payload and size validation reject invalid requests', async (t) => {
  const relay = await start(t);
  assert.equal((await post(relay, event(), { Authorization: '' })).status, 401);
  assert.equal((await post(relay, event(), { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(relay, event(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(relay, '{invalid')).status, 400);
  for (const change of [
    { channel: '/b/other' }, { type: 'c|123' }, { socketState: 'unknown' },
    { clientId: {} }, { eventId: 'bad id' }, { receivedAt: 'not-a-date' },
  ]) {
    assert.equal((await post(relay, event(change))).status, 400);
  }
  assert.equal((await post(relay, null)).status, 400);
  const oversized = JSON.stringify(event({ extra: 'x'.repeat(9000) }));
  assert.equal((await post(relay, oversized)).status, 413);
  assert.equal(relay.getStatus().newArticleCount, 0);
  assert.equal((await fetch(`${relay.baseUrl}/missing`)).status, 404);
  assert.equal((await fetch(`${relay.baseUrl}/api/relay`, { method: 'OPTIONS' })).status, 404);
});

test('rejects foreign Host headers to prevent DNS rebinding', async (t) => {
  const relay = await start(t);
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest(`${relay.baseUrl}/api/status`, { headers: { Host: 'attacker.example' } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(result, 403);
});

test('oversized chunked requests receive 413 without resetting the connection', async (t) => {
  const relay = await start(t);
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest(`${relay.baseUrl}/api/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.write('{"extra":"');
    request.write('x'.repeat(9000));
    request.end('"}');
  });
  assert.equal(result, 413);
});

test('local authentication token persists across restarts and invalid files are rejected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hotdeal-relay-test-'));
  const path = join(directory, 'relay-token');
  t.after(async () => { await unlink(path); await rmdir(directory); });
  const first = await loadRelayToken(path);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await loadRelayToken(path), first);
  assert.equal(await readFile(path, 'utf8'), first);
  await writeFile(path, 'invalid');
  await assert.rejects(loadRelayToken(path), /인증값/);
});

test('invalid configuration fails before listening', () => {
  assert.throws(() => new BrowserRelay({ token: 'short' }), /인증값/);
  assert.throws(() => new BrowserRelay({ token: TOKEN, port: NaN }), /PORT/);
  assert.throws(() => new BrowserRelay({ token: TOKEN, port: -1 }), /PORT/);
});

const postHtml = (relay, overrides = {}, headers = {}) => fetch(`${relay.baseUrl}/api/html`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
  body: JSON.stringify(event({
    type: 'html', sourceUrl: 'https://arca.live/b/hotdeal', trigger: 'initial', html: fixture,
    ...overrides,
  })),
});

test('HTML relay parses and serves the latest article list without exposing raw HTML', async (t) => {
  const relay = await start(t);
  const before = await (await fetch(`${relay.baseUrl}/api/articles`)).json();
  assert.equal(before.updatedAt, null);
  assert.equal(before.total, 0);
  const updates = [];
  relay.on('articlesUpdated', (update) => updates.push(update));
  assert.equal((await postHtml(relay)).status, 200);
  const response = await fetch(`${relay.baseUrl}/api/articles`);
  const list = await response.json();
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(list.total, 4);
  assert.equal(list.sourceUrl, 'https://arca.live/b/hotdeal');
  assert.equal(list.fetchedAt, event().receivedAt);
  assert.equal(list.articles[1].title, '[쇼핑몰] SSD & USB 특가');
  assert.equal(JSON.stringify(list).includes('<script>'), false);
  assert.equal(relay.getStatus().collection.articleCount, 4);
  assert.equal(relay.getStatus().collection.lastError, null);
  assert.equal(relay.getStatus().newArticleCount, 0);
  assert.equal(updates.length, 1);
  const duplicate = await postHtml(relay);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(updates.length, 1);
});

test('article API includes the supplied hybrid hotdeal row alongside its two notices', async (t) => {
  const relay = await start(t);
  assert.equal((await postHtml(relay, { html: hybridFixture })).status, 200);
  const list = await (await fetch(`${relay.baseUrl}/api/articles`)).json();
  assert.equal(list.total, 3);
  assert.equal(list.articles.filter((article) => article.isNotice).length, 2);
  assert.equal(list.articles.find((article) => !article.isNotice).title, '하우스 플리퍼 2');
  const before = relay.getArticles();
  const broken = hybridFixture.replace('title hybrid-title', 'changed-title').replace('vcol col-title', 'changed-column');
  const failed = await postHtml(relay, { html: broken, eventId: 'test-tab:2', receivedAt: '2026-10-12T09:01:00Z' });
  assert.equal(failed.status, 422);
  assert.deepEqual(relay.getArticles(), before);
  assert.match(relay.getStatus().collection.lastError.message, /일반 게시글/);
});

test('source HTML endpoint validates authentication, source and event type', async (t) => {
  const relay = await start(t);
  assert.equal((await postHtml(relay, {}, { Authorization: '' })).status, 401);
  for (const overrides of [
    { sourceUrl: 'https://other.example/' }, { sourceUrl: 'https://arca.live/b/hotdeal?p=2' },
    { trigger: 'poll' }, { type: 'na' }, { html: {} }, { html: 'x'.repeat(1024 * 1024 + 1) },
  ]) {
    assert.equal((await postHtml(relay, overrides)).status, 400);
  }
  assert.equal((await post(relay, event({ type: 'html' }))).status, 400);
  assert.equal(relay.getArticles().updatedAt, null);
});

test('staff notices are excluded from the article API and its total and status counts', async (t) => {
  const relay = await start(t);
  const html = hybridFixture
    .replace('첫 번째 공지</span></span>', '첫 번째 공지</span></span><span class="col-author">*ㅎㅎ</span>')
    .replace('두 번째 공지</span></span>', '두 번째 공지</span></span><span class="col-author">*운영자</span>');
  assert.equal((await postHtml(relay, { html })).status, 200);
  const list = await (await fetch(`${relay.baseUrl}/api/articles`)).json();
  assert.equal(list.total, 1);
  assert.deepEqual(list.articles.map(({ title }) => title), ['하우스 플리퍼 2']);
  assert.equal(relay.getStatus().collection.articleCount, 1);
  assert.equal(relay.getStatus().collection.lastError, null);
});

test('failed parsing or source fetching preserves last good data; older snapshots cannot overwrite it', async (t) => {
  const relay = await start(t);
  await postHtml(relay);
  const first = relay.getArticles();
  const failed = await postHtml(relay, { eventId: 'test-tab:2', receivedAt: '2026-10-12T09:01:00Z', html: '<h1>Just a moment...</h1>' });
  assert.equal(failed.status, 422);
  assert.deepEqual(relay.getArticles(), first);
  assert.match(relay.getStatus().collection.lastError.message, /목록 영역/);
  const ignored = await postHtml(relay, { eventId: 'test-tab:3', receivedAt: '2026-10-12T08:59:00Z', html: fixture.replaceAll('SSD', '구버전') });
  assert.equal((await ignored.json()).ignored, true);
  assert.deepEqual(relay.getArticles(), first);
  assert.equal((await post(relay, event({ type: 'fetchError', eventId: 'test-tab:4', receivedAt: '2026-10-12T09:02:00Z', message: '접속 제한', httpStatus: 403 }))).status, 200);
  assert.equal(relay.getStatus().collection.lastError.httpStatus, 403);
  assert.deepEqual(relay.getArticles(), first);
  assert.equal((await postHtml(relay, { eventId: 'test-tab:5', trigger: 'na', receivedAt: '2026-10-12T09:03:00Z', html: fixture.replaceAll('SSD', '새 목록') })).status, 200);
  assert.equal(relay.getStatus().collection.lastError, null);
  assert.match(relay.getArticles().articles[1].title, /새 목록/);
});
