import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import module from '../desktop/app-updates.cjs';
import { UpdateView } from '../desktop/update-view.js';

const { AppUpdates } = module;
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, options = {}) {
  const updater = Object.assign(new EventEmitter(), {
    checks: 0, downloads: 0, installs: [],
    async checkForUpdates() { this.checks++; this.emit('update-not-available'); },
    async downloadUpdate() { this.downloads++; this.emit('update-downloaded', { version: '1.2.0' }); },
    quitAndInstall(...args) { this.installs.push(args); },
  });
  const logs = [];
  let prepared = 0;
  let failed = 0;
  const manager = new AppUpdates({ updater, version: '1.1.0', enabled: true,
    beforeInstall: async () => { prepared++; }, installFailed: () => { failed++; },
    log: (...args) => logs.push(args), ...options });
  t.after(() => manager.dispose());
  const available = () => updater.emit('update-available', { version: '1.2.0', releaseNotes: '<b>unsafe</b>', files: [{ url: 'private' }] });
  return { updater, manager, logs, available, prepared: () => prepared, failed: () => failed };
}

test('development builds expose their version without checking, downloading or installing', async (t) => {
  const { manager, updater } = fixture(t, { enabled: false });
  manager.start({ initialDelay: 0, interval: 1 });
  assert.equal((await manager.check()).phase, 'disabled');
  await assert.rejects(manager.download());
  await assert.rejects(manager.install());
  await tick();
  assert.equal(updater.checks, 0);
  assert.equal(manager.snapshot().currentVersion, '1.1.0');
  assert.equal(updater.eventNames().length, 0);
});

test('automatic checks coalesce and never automatically download or install', async (t) => {
  const { manager, updater, available } = fixture(t);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  const pending = deferred();
  updater.checkForUpdates = async () => { updater.checks++; await pending.promise; available(); };
  const first = manager.check();
  const second = manager.check();
  assert.equal(first, second);
  await tick();
  assert.equal(updater.checks, 1);
  pending.resolve();
  assert.equal((await first).phase, 'available');
  assert.equal(updater.downloads, 0);
  assert.equal(updater.installs.length, 0);
  await manager.check();
  assert.equal(updater.checks, 1);
  assert.deepEqual(Object.keys(manager.snapshot()).sort(), ['currentVersion', 'error', 'phase', 'progress', 'revision', 'version']);
});

test('downloads are explicit, report progress, coalesce and wait for shutdown before installation', async (t) => {
  const stop = deferred();
  const { manager, updater, available } = fixture(t, { beforeInstall: () => stop.promise });
  available();
  const download = deferred();
  updater.downloadUpdate = async () => { updater.downloads++; await download.promise; updater.emit('update-downloaded', { version: '1.2.0' }); };
  const first = manager.download();
  assert.equal(first, manager.download());
  await tick();
  updater.emit('download-progress', { percent: 45.8 });
  assert.equal(manager.snapshot().progress, 45.8);
  assert.equal(manager.snapshot().phase, 'downloading');
  await assert.rejects(manager.install());
  download.resolve();
  assert.equal((await first).phase, 'downloaded');
  assert.equal(updater.downloads, 1);
  assert.equal(updater.installs.length, 0);
  const install = manager.install();
  assert.equal(install, manager.install());
  await tick();
  assert.equal(manager.snapshot().phase, 'installing');
  assert.equal(updater.installs.length, 0);
  stop.resolve();
  await install;
  assert.deepEqual(updater.installs, [[true, true]]);
});

test('network and checksum failures are safe to retry without leaking provider errors', async (t) => {
  const { manager, updater, logs, available } = fixture(t);
  updater.checkForUpdates = async () => {
    const error = new Error('Authorization: private-token https://example.com?secret=private');
    updater.emit('error', error);
    throw error;
  };
  assert.equal((await manager.check()).phase, 'error');
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify([logs, manager.snapshot()]), /private-token|secret=|Authorization/);
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  assert.equal((await manager.check()).phase, 'idle');
  assert.equal(manager.snapshot().error, null);
  available();
  updater.downloadUpdate = async () => { throw new Error('SHA512 checksum mismatch'); };
  assert.equal((await manager.download()).phase, 'available');
  assert.match(manager.snapshot().error, /다운로드/);
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '1.2.0' });
  assert.equal((await manager.download()).phase, 'downloaded');
  assert.equal(manager.snapshot().error, null);
});

test('shutdown failure or installer error keeps the app alive and allows retry', async (t) => {
  const stop = deferred();
  const { manager, updater, available, failed } = fixture(t, { beforeInstall: () => stop.promise });
  available();
  await manager.download();
  const install = manager.install();
  stop.reject(new Error('worker did not stop'));
  assert.equal((await install).phase, 'downloaded');
  assert.equal(updater.installs.length, 0);
  assert.equal(failed(), 1);
  const next = fixture(t);
  next.available();
  await next.manager.download();
  next.updater.quitAndInstall = () => next.updater.emit('error', new Error('installer missing'));
  assert.equal((await next.manager.install()).phase, 'downloaded');
  assert.equal(next.failed(), 1);
  next.updater.quitAndInstall = () => {};
  assert.equal((await next.manager.install()).phase, 'installing');
});

test('periodic checks are scheduled once and dispose prevents late state changes', async (t) => {
  const { manager, updater } = fixture(t);
  manager.start({ initialDelay: 0, interval: 10 });
  manager.start({ initialDelay: 0, interval: 10 });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(updater.checks >= 2);
  const pending = deferred();
  updater.checkForUpdates = () => pending.promise;
  const check = manager.check();
  await tick();
  manager.dispose();
  const state = manager.snapshot();
  pending.reject(new Error('late failure'));
  await check;
  updater.emit('update-available', { version: '9.0.0' });
  assert.deepEqual(manager.snapshot(), state);
  const checks = updater.checks;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(updater.checks, checks);
});

function viewFixture() {
  const elements = { version: {}, status: {}, button: { addEventListener(_name, callback) { this.click = callback; } } };
  let onUpdate;
  let download = 0;
  let install = 0;
  const state = (revision, phase, extra = {}) => ({ revision, currentVersion: '1.1.0', phase, version: '1.2.0', error: null, progress: 0, ...extra });
  const api = {
    onUpdate(callback) { onUpdate = callback; },
    async updateState() { return state(0, 'idle'); },
    async downloadUpdate() { download++; return state(2, 'downloaded'); },
    async installUpdate() { install++; return state(3, 'installing'); },
  };
  const view = new UpdateView(api, elements);
  return { view, api, elements, state, send: (...args) => onUpdate(...args), downloads: () => download, installs: () => install };
}

test('title displays the running version and shows update button only for an available update', async () => {
  const { view, elements, state, send, downloads, installs } = viewFixture();
  await view.initialize();
  assert.equal(elements.version.textContent, 'v1.1.0');
  assert.equal(elements.button.hidden, true);
  send(state(1, 'available'));
  assert.equal(elements.button.hidden, false);
  assert.equal(elements.button.textContent, '업데이트 v1.2.0');
  elements.button.click();
  elements.button.click();
  await tick();
  assert.equal(downloads(), 1);
  assert.equal(elements.button.textContent, '재시작 및 설치');
  elements.button.click();
  await tick();
  assert.equal(installs(), 1);
  assert.equal(elements.button.disabled, true);
  send(state(2, 'available'));
  assert.equal(elements.button.disabled, true);
});

test('view ignores stale initial IPC replies and preserves the version when offline', async () => {
  const { view, api, elements, state, send } = viewFixture();
  const pending = deferred();
  api.updateState = () => pending.promise;
  const init = view.initialize();
  send(state(4, 'downloading', { progress: 29.7 }));
  pending.resolve(state(0, 'idle'));
  await init;
  assert.equal(elements.button.textContent, '다운로드 29%');
  assert.equal(elements.button.disabled, true);
  send(state(5, 'error', { version: null, error: '인터넷 연결 확인' }));
  assert.equal(elements.version.textContent, 'v1.1.0');
  assert.equal(elements.button.hidden, true);
  assert.equal(elements.status.textContent, '인터넷 연결 확인');
});
