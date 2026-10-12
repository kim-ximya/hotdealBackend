import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { once } from 'node:events';
import { BrowserRelay, renderUserscript } from '../src/browser-relay.js';

const TOKEN = 'test_token_'.repeat(4);
const template = await readFile(new URL('../browser/hotdeal-relay.user.js', import.meta.url), 'utf8');
const fixture = await readFile(new URL('./fixtures/hotdeal-list.html', import.meta.url), 'utf8');

function browser({ baseUrl = 'http://127.0.0.1:38471', transport, pathname = '/b/hotdeal', sourceFetch } = {}) {
  const requests = [];
  const sockets = [];
  const timeouts = [];
  const intervals = [];
  const warnings = [];
  const errors = [];
  const sourceRequests = [];
  let clock = Date.now();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const document = new EventTarget();
  document.readyState = 'loading';
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    constructor(url) {
      super();
      this.url = url;
      this.sent = [];
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    receive(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    close() { this.dispatchEvent(new Event('close')); }
    fail() { this.dispatchEvent(new Event('error')); }
  }
  const unsafeWindow = { WebSocket: FakeWebSocket, fetch(url, options) {
    sourceRequests.push({ url, options });
    return sourceFetch ? sourceFetch(url, options) : Promise.resolve(new Response(fixture, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  } };
  runInNewContext(renderUserscript(template, { token: TOKEN, baseUrl }), {
    unsafeWindow, location: { pathname, href: `https://arca.live${pathname}` }, URL,
    document, AbortSignal, TextEncoder, Date: ClockDate,
    crypto: { randomUUID: () => 'test-tab' },
    console: { info() {}, warn: (message) => warnings.push(message), error: (message) => errors.push(message) },
    GM_xmlhttpRequest(options) {
      requests.push(options);
      if (transport) transport(options);
      else options.onload({ status: 200 });
    },
    setTimeout(callback, delay) {
      const timer = { delay, at: clock + delay, fired: false, callback: () => { timer.fired = true; return callback(); } };
      timeouts.push(timer);
      return timeouts.length;
    },
    setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; },
  });
  return { unsafeWindow, FakeWebSocket, requests, sockets, timeouts, intervals, warnings, errors, sourceRequests,
    loaded() { document.readyState = 'complete'; document.dispatchEvent(new Event('DOMContentLoaded')); },
    async runNextTimeout() {
      const timer = timeouts.filter((entry) => !entry.fired).sort((a, b) => a.at - b.at)[0];
      assert.ok(timer, 'a scheduled timer must exist');
      clock = timer.at;
      timer.callback();
      await new Promise(setImmediate);
      return timer;
    },
    events: () => requests.map((request) => JSON.parse(request.data)),
    connect(url = 'wss://arca.live/arcalive') { return new unsafeWindow.WebSocket(url); },
  };
}

test('observes the site socket without creating one; preserves constructor and outgoing messages', () => {
  const page = browser();
  assert.equal(page.sockets.length, 0);
  assert.equal(page.unsafeWindow.WebSocket.OPEN, 1);
  assert.equal(page.unsafeWindow.WebSocket.prototype, page.FakeWebSocket.prototype);
  const socket = page.connect();
  assert.ok(socket instanceof page.FakeWebSocket);
  socket.send('hello');
  socket.send('c|/b/hotdeal');
  assert.deepEqual(socket.sent, ['hello', 'c|/b/hotdeal']);
  assert.deepEqual(page.events().map((event) => event.type), ['ready', 'subscribed']);
  assert.equal(page.requests[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(page.requests[0].anonymous, true);
  assert.equal(page.intervals[0].delay, 15_000);
});

test('filters exact na only on the subscribed hotdeal socket, including reconnects', () => {
  const page = browser();
  const socket = page.connect();
  socket.receive('na');
  socket.send('c|/b/other');
  socket.receive('na');
  const unrelated = page.connect('wss://other.example/arcalive');
  unrelated.send('c|/b/hotdeal');
  unrelated.receive('na');
  socket.send('c|/b/hotdeal');
  for (const data of ['c|23505', 'na\n', 'na|1', new ArrayBuffer(2)]) socket.receive(data);
  assert.equal(page.events().filter((event) => event.type === 'na').length, 0);
  socket.receive('na');
  assert.equal(page.events().filter((event) => event.type === 'na').length, 1);
  page.intervals[0].callback();
  assert.equal(page.events().at(-1).socketState, 'receiving');
  const replacement = page.connect();
  replacement.send('c|/b/hotdeal');
  socket.close();
  assert.equal(page.events().at(-1).type, 'subscribed');
  replacement.receive('na');
  assert.equal(page.events().filter((event) => event.type === 'na').length, 2);
  replacement.fail();
  assert.equal(page.events().at(-1).socketState, 'error');
  replacement.close();
  assert.equal(page.events().at(-1).type, 'disconnected');
});

test('unsubscribe stops forwarding and similarly named channels are ignored', () => {
  const page = browser();
  const socket = page.connect();
  socket.send('c|/b/hotdeal');
  socket.send('c|/b/other');
  socket.receive('na');
  page.intervals[0].callback();
  assert.equal(page.events().at(-1).socketState, 'waiting');
  assert.equal(page.events().some((event) => event.type === 'na'), false);
  const wrongPage = browser({ pathname: '/b/hotdealother' });
  assert.equal(wrongPage.requests.length, 0);
  assert.equal(wrongPage.unsafeWindow.WebSocket, wrongPage.FakeWebSocket);
});

test('failed delivery retries after five seconds with the same event ID and drains pending notifications', () => {
  let offline = true;
  const page = browser({ transport: (options) => offline ? options.onerror() : options.onload({ status: 200 }) });
  const socket = page.connect();
  socket.send('c|/b/hotdeal');
  socket.receive('na');
  assert.equal(page.requests.length, 1);
  assert.equal(page.timeouts[0].delay, 5000);
  offline = false;
  page.timeouts[0].callback();
  assert.deepEqual(page.events().map((event) => event.type), ['ready', 'ready', 'subscribed', 'na']);
  assert.equal(page.events()[0].eventId, page.events()[1].eventId);
});

test('authentication failure pauses transmission until script reinstall and page reload', () => {
  const page = browser({ transport: (options) => options.onload({ status: 401 }) });
  const socket = page.connect();
  socket.send('c|/b/hotdeal');
  socket.receive('na');
  page.intervals[0].callback();
  assert.equal(page.requests.length, 1);
  assert.equal(page.timeouts.length, 0);
  assert.match(page.errors[0], /다시 설치/);
});

test('offline queue is bounded and retains its unacknowledged head', () => {
  let offline = true;
  const page = browser({ transport: (options) => offline ? options.onerror() : options.onload({ status: 200 }) });
  const socket = page.connect();
  socket.send('c|/b/hotdeal');
  for (let index = 0; index < 110; index++) socket.receive('na');
  offline = false;
  page.timeouts[0].callback();
  const delivered = page.events().slice(1);
  assert.equal(delivered.length, 100);
  assert.equal(delivered[0].type, 'ready');
  assert.equal(delivered.filter((event) => event.type === 'na').length, 99);
  assert.equal(page.warnings.filter((message) => message.includes('가득')).length, 12);
});

test('userscript → real localhost HTTP backend delivers na end to end', { timeout: 5000 }, async (t) => {
  const relay = new BrowserRelay({ token: TOKEN, port: 0 });
  await relay.start();
  t.after(() => relay.stop());
  const pending = [];
  const page = browser({ baseUrl: relay.baseUrl, transport(options) {
    pending.push(fetch(options.url, { method: options.method, headers: options.headers, body: options.data })
      .then((response) => { options.onload({ status: response.status }); })
      .catch(() => options.onerror()));
  } });
  const notification = once(relay, 'newArticle');
  const socket = page.connect();
  socket.send('hello');
  socket.send('c|/b/hotdeal');
  socket.receive('c|23505');
  socket.receive('na');
  const [received] = await notification;
  // Each success schedules the next queued delivery, so await the changing list.
  for (let index = 0; index < pending.length; index++) await pending[index];
  assert.equal(received.channel, '/b/hotdeal');
  assert.equal(relay.getStatus().newArticleCount, 1);
  assert.equal(relay.getStatus().socketReceiving, true);
  assert.equal(page.errors.length, 0);
});

test('initial HTTP fetch and bursts of na refresh the fixed first page with browser credentials', async () => {
  const page = browser();
  assert.equal(page.sourceRequests.length, 0);
  page.loaded();
  await page.runNextTimeout();
  assert.equal(page.sourceRequests.length, 1);
  const initial = page.events().find((event) => event.type === 'html');
  assert.equal(initial.trigger, 'initial');
  assert.equal(initial.html, fixture);
  const socket = page.connect();
  socket.send('c|/b/hotdeal');
  socket.receive('c|23505');
  assert.equal(page.sourceRequests.length, 1);
  socket.receive('na');
  socket.receive('na');
  socket.receive('na');
  assert.equal(page.sourceRequests.length, 1);
  const timer = await page.runNextTimeout();
  assert.equal(timer.delay, 3000);
  assert.equal(page.sourceRequests.length, 2);
  assert.equal(page.events().filter((event) => event.type === 'na').length, 3);
  assert.equal(page.events().filter((event) => event.type === 'html').length, 2);
  assert.equal(page.events().at(-1).trigger, 'na');
  assert.equal(page.requests.at(-1).url, 'http://127.0.0.1:38471/api/html');
  for (const request of page.sourceRequests) {
    assert.equal(request.url, 'https://arca.live/b/hotdeal');
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.cache, 'no-cache');
    assert.equal(request.options.headers.Authorization, undefined);
  }
});

test('na during an HTTP request schedules one trailing refresh without concurrent requests', async () => {
  let resolveFetch;
  let calls = 0;
  const page = browser({ sourceFetch: () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { resolveFetch = resolve; });
    return Promise.resolve(new Response(fixture, { headers: { 'Content-Type': 'text/html' } }));
  } });
  page.loaded();
  await page.runNextTimeout();
  const socket = page.connect();
  socket.send('c|/b/hotdeal');
  socket.receive('na');
  socket.receive('na');
  assert.equal(calls, 1);
  assert.equal(page.timeouts.filter((timer) => !timer.fired).length, 0);
  resolveFetch(new Response(fixture, { headers: { 'Content-Type': 'text/html' } }));
  await new Promise(setImmediate);
  await page.runNextTimeout();
  assert.equal(calls, 2);
  assert.equal(page.events().filter((event) => event.type === 'html').length, 2);
});

test('HTTP access restrictions stop further source requests until the tab is reloaded', async () => {
  const page = browser({ sourceFetch: () => Promise.resolve(new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } })) });
  page.loaded();
  await page.runNextTimeout();
  const failure = page.events().find((event) => event.type === 'fetchError');
  assert.equal(failure.httpStatus, 403);
  assert.match(failure.message, /보안 확인/);
  const socket = page.connect();
  socket.send('c|/b/hotdeal');
  socket.receive('na');
  assert.equal(page.sourceRequests.length, 1);
  assert.equal(page.timeouts.filter((timer) => !timer.fired).length, 0);
  assert.equal(page.events().some((event) => event.type === 'html'), false);
});

test('network, content type, redirect and size failures are relayed without posting HTML', async () => {
  for (const sourceFetch of [
    () => Promise.reject(new Error('network offline')),
    () => Promise.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } })),
    () => {
      const response = new Response('login', { headers: { 'Content-Type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: 'https://arca.live/account/login' });
      return Promise.resolve(response);
    },
    () => Promise.resolve(new Response('한'.repeat(400_000), { headers: { 'Content-Type': 'text/html' } })),
  ]) {
    const page = browser({ sourceFetch });
    page.loaded();
    await page.runNextTimeout();
    assert.equal(page.events().filter((event) => event.type === 'fetchError').length, 1);
    assert.equal(page.events().some((event) => event.type === 'html'), false);
    assert.equal(page.timeouts.filter((timer) => !timer.fired).length, 0);
  }
});

test('parser rejection drops that snapshot and continues delivering later events', async () => {
  const page = browser({ transport: (options) => options.onload({ status: options.url.endsWith('/api/html') ? 422 : 200 }) });
  page.loaded();
  await page.runNextTimeout();
  page.intervals[0].callback();
  assert.equal(page.events().at(-1).type, 'heartbeat');
  assert.match(page.errors[0], /422/);
  assert.equal(page.timeouts.filter((timer) => !timer.fired).length, 0);
});

test('browser HTTP HTML → authenticated relay → parsed article API end to end', { timeout: 5000 }, async (t) => {
  const relay = new BrowserRelay({ token: TOKEN, port: 0 });
  await relay.start();
  t.after(() => relay.stop());
  const pending = [];
  const page = browser({ baseUrl: relay.baseUrl, transport(options) {
    pending.push(fetch(options.url, { method: options.method, headers: options.headers, body: options.data })
      .then((response) => options.onload({ status: response.status }))
      .catch(() => options.onerror()));
  } });
  page.loaded();
  const update = once(relay, 'articlesUpdated');
  await page.runNextTimeout();
  await update;
  for (let index = 0; index < pending.length; index++) await pending[index];
  const list = await (await fetch(`${relay.baseUrl}/api/articles`)).json();
  assert.equal(list.total, 4);
  assert.equal(list.articles[1].title, '[쇼핑몰] SSD & USB 특가');
  assert.equal(relay.getStatus().collection.lastError, null);
});
