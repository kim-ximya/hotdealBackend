import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import module from '../desktop/log-window.cjs';

const { LogWindow } = module;
const page = pathToFileURL(join(import.meta.dirname, '../desktop/logs.html')).href;

function fixture(t) {
  const windows = [];
  const handlers = new Map();
  let load = () => Promise.resolve();
  class Window extends EventEmitter {
    destroyed = false;
    minimized = false;
    shown = 0;
    focused = 0;
    restored = 0;
    hidden = 0;
    sent = [];
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: page }, send: (...args) => this.sent.push(args),
      setWindowOpenHandler: (handler) => { this.openHandler = handler; },
    });
    constructor(options) { super(); this.options = options; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.restored++; this.minimized = false; }
    show() { this.shown++; }
    focus() { this.focused++; }
    hide() { this.hidden++; }
    setMenu() {}
    loadFile() { return load(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  let id = 0;
  const controller = Object.assign(new EventEmitter(), {
    logs: [], cleared: 0,
    snapshot() { return { logs: structuredClone(this.logs), dataDirectory: '/private', userAgent: 'private' }; },
    clearLogs() { this.cleared++; this.logs = []; this.emit('snapshot', this.snapshot()); },
  });
  const append = (message, level = 'info') => {
    controller.logs.push({ id: ++id, at: new Date().toISOString(), level, message });
    controller.emit('snapshot', controller.snapshot());
  };
  append('initial');
  const manager = new LogWindow({ BrowserWindow: Window, controller, icon: 'icon.ico',
    ipcMain: { handle: (name, callback) => handlers.set(name, callback), removeHandler: (name) => handlers.delete(name) } });
  t.after(() => manager.dispose());
  const event = (win = windows.at(-1)) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const invoke = (action, sender = event()) => handlers.get(`hotdeal-logs:${action}`)(sender);
  return { manager, windows, controller, handlers, append, invoke, event, load: (value) => { load = value; } };
}

test('logs open once, restore an existing window, and reopen with the full session history after closing', async (t) => {
  const { manager, windows, controller, append, invoke } = fixture(t);
  await Promise.all([manager.open(), manager.open()]);
  assert.equal(windows.length, 1);
  const first = windows[0];
  assert.equal(first.options.webPreferences.sandbox, true);
  assert.equal(first.options.webPreferences.contextIsolation, true);
  assert.equal(first.options.webPreferences.nodeIntegration, false);
  assert.match(first.options.webPreferences.preload, /logs-preload\.cjs$/);
  assert.equal(first.options.modal, undefined);
  first.minimized = true;
  await manager.open();
  assert.equal(windows.length, 1);
  assert.equal(first.restored, 1);
  first.destroy();
  append('while closed');
  await manager.open();
  assert.equal(windows.length, 2);
  assert.deepEqual((await invoke('read')).value.logs.map(({ message }) => message), ['initial', 'while closed']);
  assert.equal(controller.listenerCount('snapshot'), 1);
  assert.equal(controller.cleared, 0);
});

test('log updates deliver only log data and do not redraw on unrelated status changes; clear updates the same session', async (t) => {
  const { manager, windows, controller, append, invoke } = fixture(t);
  await manager.open();
  const win = windows[0];
  const count = win.sent.length;
  controller.emit('snapshot', controller.snapshot());
  assert.equal(win.sent.length, count);
  append('browser event', 'browser');
  const [channel, update] = win.sent.at(-1);
  assert.equal(channel, 'hotdeal-logs:update');
  assert.deepEqual(Object.keys(update).sort(), ['logs', 'revision']);
  assert.equal(update.logs.length, 2);
  const copy = (await invoke('read')).value;
  copy.logs.length = 0;
  assert.equal((await invoke('read')).value.logs.length, 2);
  const cleared = (await invoke('clear')).value;
  assert.deepEqual(cleared.logs, []);
  assert.ok(cleared.revision > update.revision);
  assert.deepEqual(win.sent.at(-1)[1], cleared);
  assert.equal(controller.cleared, 1);
});

test('logs reject foreign windows, subframes, navigated pages and stale windows', async (t) => {
  const { manager, windows, invoke, event, handlers } = fixture(t);
  await manager.open();
  const first = windows[0];
  assert.deepEqual(first.openHandler(), { action: 'deny' });
  for (const action of ['read', 'clear']) {
    await assert.rejects(invoke(action, { ...event(), sender: {} }), /허용되지/);
    await assert.rejects(invoke(action, { ...event(), senderFrame: { url: page } }), /허용되지/);
    first.webContents.mainFrame.url = 'https://example.com';
    await assert.rejects(invoke(action), /허용되지/);
    first.webContents.mainFrame.url = page;
  }
  first.destroy();
  await manager.open();
  await assert.rejects(invoke('clear', event(first)), /허용되지/);
  assert.deepEqual([...handlers.keys()].sort(), ['hotdeal-logs:clear', 'hotdeal-logs:read']);
});

test('hiding during load never reopens a tray-hidden app; opening again restores the log window', async (t) => {
  const { manager, windows, load } = fixture(t);
  let finish;
  load(() => new Promise((resolve) => { finish = resolve; }));
  const opening = manager.open();
  await new Promise(setImmediate);
  manager.hide();
  finish();
  await opening;
  assert.equal(windows[0].shown, 0);
  await manager.open();
  assert.equal(windows[0].shown, 1);
});

test('load failures and renderer crashes allow a fresh window; disposal removes IPC and subscriptions even during load', async (t) => {
  const { manager, windows, controller, handlers, load } = fixture(t);
  load(() => Promise.reject(new Error('load failed')));
  await assert.rejects(manager.open(), /load failed/);
  assert.equal(windows[0].destroyed, true);
  load(() => Promise.resolve());
  await manager.open();
  windows[1].webContents.emit('render-process-gone');
  assert.equal(windows[1].destroyed, true);
  let finish;
  load(() => new Promise((resolve) => { finish = resolve; }));
  const opening = manager.open();
  await new Promise(setImmediate);
  manager.dispose();
  finish();
  await opening;
  assert.equal(windows[2].shown, 0);
  assert.equal(controller.listenerCount('snapshot'), 0);
  assert.equal(handlers.size, 0);
  await assert.rejects(manager.open(), /종료 중/);
});
