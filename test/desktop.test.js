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
