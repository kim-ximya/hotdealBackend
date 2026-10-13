import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NewArticleTracker } from '../desktop/new-article-tracker.js';
import { loadNotificationSettings, saveNotificationSettings } from '../desktop/notification-settings.js';
import notifications from '../desktop/floating-notifications.cjs';

const article = (id, extra = {}) => ({ id, title: `핫딜 ${id}`, category: '게임', author: '일반 작성자', ...extra });

test('new-post watermark uses exact IDs, ignores notices, deduplicates and suppresses historical reappearance', () => {
  const tracker = new NewArticleTracker();
  assert.deepEqual(tracker.observe([article('9007199254740993')]), []);
  assert.deepEqual(tracker.observe([article('9007199254740994'), article('9007199254740994'),
    article('9007199254740992'), article('9007199254740996', { author: '*운영진' }), article('9007199254740997', { isNotice: true })])
    .map(({ id }) => id), ['9007199254740994']);
  assert.deepEqual(tracker.observe([article('9007199254740994', { title: '수정됨' }), article('1')]), []);
  assert.deepEqual(tracker.observe([article('9007199254740995')]).map(({ id }) => id), ['9007199254740995']);
});

test('notification settings persist independently and invalid input never overwrites them', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hotdeal-notifications-'));
  const path = join(directory, 'settings.json');
  t.after(async () => { await unlink(path); await rmdir(directory); });
  assert.deepEqual(await loadNotificationSettings(path), { enabled: true, soundEnabled: true });
  await saveNotificationSettings(path, { enabled: false, soundEnabled: false });
  const before = await readFile(path, 'utf8');
  await assert.rejects(saveNotificationSettings(path, { enabled: 'yes', soundEnabled: true }));
  await assert.rejects(saveNotificationSettings(path, { enabled: true, soundEnabled: true, extra: 1 }));
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await loadNotificationSettings(path), { enabled: false, soundEnabled: false });
});

test('an empty successful baseline still announces subsequent first posts, while a fresh install does not', () => {
  const fresh = new NewArticleTracker();
  assert.deepEqual(fresh.observe([article('1')]), []);
  const empty = new NewArticleTracker([]);
  assert.deepEqual(empty.observe([article('1')]).map(({ id }) => id), ['1']);
});

function fixture(t) {
  const windows = [];
  class Window extends EventEmitter {
    destroyed = false;
    sent = [];
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: pathToFileURL(join(import.meta.dirname, '../desktop/notification.html')).href },
      setWindowOpenHandler: () => {}, send: (...args) => this.sent.push(args),
    });
    constructor(options) { super(); this.options = options; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    setMenu() {}
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return { ...this.bounds }; }
    showInactive() { this.shownInactive = true; }
    isVisible() { return this.shownInactive && !this.destroyed; }
    moveTop() { this.movedTop = true; }
    setAlwaysOnTop(value) { this.onTop = value; }
    loadFile() { return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }) });
  screen.getDisplayMatching = screen.getPrimaryDisplay;
  let settings = { enabled: true, soundEnabled: true };
  const timers = new Map();
  let timerId = 0;
  const opened = [];
  const manager = new notifications.FloatingNotifications({ BrowserWindow: Window, ipcMain, screen,
    getMainWindow: () => null, showMainWindow: () => opened.push('list'), openArticle: async (id) => opened.push(id),
    getSettings: () => settings, log: () => {},
    setTimer: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; }, clearTimer: (id) => timers.delete(id),
  });
  t.after(() => manager.dispose());
  const invoke = (action, value, event) => {
    const win = windows.at(-1);
    return handlers.get('hotdeal-notification:action')(event || { sender: win.webContents, senderFrame: win.webContents.mainFrame }, action, value);
  };
  return { manager, windows, timers, opened, invoke, screen, handlers, settings: (value) => { settings = value; } };
}

test('floating window groups arrivals, never focuses, fits the work area and pauses expiry while hovered', async (t) => {
  const { manager, windows, timers, invoke } = fixture(t);
  manager.show([article('1'), article('2')]);
  const win = windows[0];
  win.emit('ready-to-show');
  assert.equal(win.shownInactive, true);
  assert.equal(win.movedTop, true);
  assert.equal(win.onTop, true);
  assert.equal(win.options.skipTaskbar, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.ok(win.bounds.x >= -1920 && win.bounds.x + win.bounds.width <= 0);
  assert.ok(win.bounds.y + win.bounds.height <= 1040);
  assert.equal([...timers.values()][0].ms, 8000);
  await invoke('hover', true);
  assert.equal(timers.size, 0);
  manager.show([article('3'), article('4')]);
  assert.equal(windows.length, 1);
  assert.equal(timers.size, 0);
  const payload = (await invoke('ready')).value;
  assert.equal(payload.total, 4);
  assert.deepEqual(payload.articles.map(({ id }) => id), ['4', '3', '2']);
  await invoke('hover', false);
  [...timers.values()][0].callback();
  assert.equal(win.destroyed, true);
  assert.equal(timers.size, 0);
});

test('mute disables automatic windows, preview respects sound, and IPC rejects untrusted frames and IDs', async (t) => {
  const { manager, windows, invoke, settings, opened, handlers, screen } = fixture(t);
  settings({ enabled: false, soundEnabled: false });
  manager.show([article('1')]);
  assert.equal(windows.length, 0);
  manager.showDemo();
  windows[0].emit('ready-to-show');
  assert.equal((await invoke('ready')).value.sound, false);
  await assert.rejects(invoke('close', undefined, { sender: {}, senderFrame: {} }), /허용되지/);
  assert.equal((await invoke('article', 'https://example.com')).ok, false);
  assert.deepEqual(opened, []);
  await invoke('list');
  assert.deepEqual(opened, ['list']);
  settings({ enabled: true, soundEnabled: true });
  manager.show([article('3')]);
  windows[1].emit('ready-to-show');
  assert.equal((await invoke('article', '2')).ok, false);
  assert.equal((await invoke('article', '3')).ok, true);
  assert.deepEqual(opened, ['list', '3']);
  manager.dispose();
  assert.equal(handlers.size, 0);
  assert.equal(screen.listenerCount('display-removed'), 0);
});

test('a short swipe returns to its anchor, updates do not interrupt dragging, and expiry stays paused', async (t) => {
  const { manager, windows, invoke, timers } = fixture(t);
  manager.show([article('1')]);
  const win = windows[0]; win.emit('ready-to-show');
  const origin = { ...win.bounds };
  const start = origin.x + 100;
  await invoke('drag-start', start);
  assert.equal(timers.size, 0);
  await invoke('hover', false);
  assert.equal(timers.size, 0);
  await invoke('drag-move', start + 40);
  assert.equal(win.bounds.x, origin.x + 40);
  manager.show([article('2')]);
  assert.equal(win.bounds.x, origin.x + 40);
  assert.equal(timers.size, 0);
  assert.equal((await invoke('drag-end', start + 40)).value, false);
  assert.equal(win.bounds.x, origin.x);
  assert.equal(win.destroyed, false);
  assert.equal(timers.size, 1);
});

test('a right swipe dismisses on release, including a short swipe that reaches a monitor edge', async (t) => {
  const { manager, windows, invoke, timers } = fixture(t);
  manager.showDemo(); windows[0].emit('ready-to-show');
  const start = windows[0].bounds.x + 100;
  await invoke('drag-start', start);
  await invoke('drag-move', start + 100);
  assert.equal(windows[0].destroyed, false);
  assert.equal((await invoke('drag-end', start + 100)).value, true);
  assert.equal(windows[0].destroyed, true);
  assert.equal(timers.size, 0);
  manager.showDemo(); windows[1].emit('ready-to-show');
  // This display ends at x=0, exercising negative screen coordinates.
  await invoke('drag-start', -25);
  assert.equal((await invoke('drag-end', -1)).value, true);
  assert.equal(windows[1].destroyed, true);
});

test('left swipes and cancelled gestures preserve the window; malformed coordinates cannot move it', async (t) => {
  const { manager, windows, invoke } = fixture(t);
  manager.showDemo(); const win = windows[0]; win.emit('ready-to-show');
  const origin = { ...win.bounds };
  for (const value of [NaN, Infinity, '123', {}, 1000001]) assert.equal((await invoke('drag-start', value)).ok, false);
  assert.deepEqual(win.bounds, origin);
  await invoke('drag-start', -200);
  await invoke('drag-move', -250);
  assert.equal(win.bounds.x, origin.x);
  assert.equal((await invoke('drag-end', -250)).value, false);
  await invoke('drag-start', -200);
  await invoke('drag-move', -80);
  await invoke('drag-cancel');
  assert.deepEqual(win.bounds, origin);
  assert.equal(win.destroyed, false);
  await invoke('drag-start', -200);
  await invoke('drag-move', -160);
  manager.dispose();
  assert.equal(win.destroyed, true);
});
