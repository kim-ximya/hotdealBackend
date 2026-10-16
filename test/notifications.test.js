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
import { createInterestMatcher } from '../src/interests.js';

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

function fixture(t, { filterArticles } = {}) {
  const windows = [];
  class Window extends EventEmitter {
    destroyed = false;
    sent = [];
    opacity = 1;
    boundsHistory = [];
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: pathToFileURL(join(import.meta.dirname, '../desktop/notification.html')).href },
      setWindowOpenHandler: () => {}, send: (...args) => this.sent.push(args),
    });
    constructor(options) { super(); this.options = options; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    setMenu() {}
    setBounds(bounds) { this.bounds = bounds; this.boundsHistory.push({ ...bounds }); }
    getBounds() { return { ...this.bounds }; }
    setOpacity(value) { this.opacity = value; }
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
  const animations = new Map();
  let animationTime = 0;
  let animationId = 0;
  const advance = (milliseconds) => {
    const until = animationTime + milliseconds;
    while (animations.size) {
      const [id, timer] = [...animations.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (timer.at > until) break;
      animations.delete(id); animationTime = timer.at; timer.callback();
    }
    animationTime = until;
  };
  const opened = [];
  const manager = new notifications.FloatingNotifications({ BrowserWindow: Window, ipcMain, screen,
    getMainWindow: () => null, showMainWindow: () => opened.push('list'), openArticle: async (id) => opened.push(id),
    getSettings: () => settings, log: () => {}, filterArticles,
    setTimer: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; }, clearTimer: (id) => timers.delete(id),
    animationNow: () => animationTime,
    setAnimationTimer: (callback, ms) => { animations.set(++animationId, { callback, at: animationTime + ms }); return animationId; },
    clearAnimationTimer: (id) => animations.delete(id),
  });
  t.after(() => manager.dispose());
  const invoke = (action, value, event) => {
    const win = windows.at(-1);
    return handlers.get('hotdeal-notification:action')(event || { sender: win.webContents, senderFrame: win.webContents.mainFrame }, action, value);
  };
  return { manager, windows, timers, animations, advance, opened, invoke, screen, handlers, settings: (value) => { settings = value; } };
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

test('a short swipe eases back from its release position, and expiry stays paused until the transition ends', async (t) => {
  const { manager, windows, invoke, timers, advance } = fixture(t);
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
  const completion = invoke('drag-end', start + 40);
  assert.equal(win.bounds.x, origin.x + 40);
  assert.equal(timers.size, 0);
  advance(96);
  assert.ok(win.bounds.x > origin.x && win.bounds.x < origin.x + 40);
  const midway = win.bounds.x;
  manager.show([article('3')]);
  assert.equal(win.bounds.x, midway);
  assert.equal(timers.size, 0);
  advance(224);
  assert.equal((await completion).value, false);
  assert.equal(win.bounds.x, origin.x);
  assert.equal(win.destroyed, false);
  assert.equal(timers.size, 1);
});

test('a right swipe slides and fades from release before closing, including at a monitor edge', async (t) => {
  const { manager, windows, invoke, timers, advance } = fixture(t);
  manager.showDemo(); windows[0].emit('ready-to-show');
  const start = windows[0].bounds.x + 100;
  await invoke('drag-start', start);
  await invoke('drag-move', start + 100);
  assert.equal(windows[0].destroyed, false);
  const releaseX = windows[0].bounds.x;
  const completion = invoke('drag-end', start + 100);
  assert.equal(windows[0].bounds.x, releaseX);
  assert.equal(windows[0].destroyed, false);
  assert.equal(windows[0].opacity, 1);
  advance(96);
  assert.ok(windows[0].bounds.x > releaseX);
  assert.ok(windows[0].opacity > 0 && windows[0].opacity < 1);
  assert.equal(windows[0].destroyed, false);
  advance(224);
  assert.equal((await completion).value, true);
  assert.equal(windows[0].destroyed, true);
  assert.equal(timers.size, 0);
  manager.showDemo(); windows[1].emit('ready-to-show');
  // This display ends at x=0, exercising negative screen coordinates.
  await invoke('drag-start', -25);
  const edgeCompletion = invoke('drag-end', -1);
  advance(320);
  assert.equal((await edgeCompletion).value, true);
  assert.equal(windows[1].destroyed, true);
});

test('left swipes and cancelled gestures preserve the window; malformed coordinates cannot move it', async (t) => {
  const { manager, windows, invoke, advance } = fixture(t);
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
  const cancellation = invoke('drag-cancel');
  advance(320);
  await cancellation;
  assert.deepEqual(win.bounds, origin);
  assert.equal(win.destroyed, false);
  await invoke('drag-start', -200);
  await invoke('drag-move', -160);
  manager.dispose();
  assert.equal(win.destroyed, true);
});

test('arrivals during dismissal appear after the outgoing window finishes without reviving the dismissed batch', async (t) => {
  const { manager, windows, invoke, advance } = fixture(t);
  manager.show([article('1')]); windows[0].emit('ready-to-show');
  await invoke('drag-start', -200);
  const completion = invoke('drag-end', -80);
  advance(64);
  manager.show([article('2')]); manager.show([article('3')]);
  assert.equal(windows.length, 1);
  advance(256);
  assert.equal((await completion).value, true);
  assert.equal(windows.length, 2);
  windows[1].emit('ready-to-show');
  assert.equal(windows[1].opacity, 1);
  const payload = (await invoke('ready')).value;
  assert.deepEqual(payload.articles.map(({ id }) => id), ['3', '2']);
});

test('shutdown cancels an animation and queued arrivals; display changes restore the anchor without stale frames', async (t) => {
  const { manager, windows, invoke, advance, animations, screen } = fixture(t);
  manager.showDemo(); const win = windows[0]; win.emit('ready-to-show');
  const origin = { ...win.bounds };
  await invoke('drag-start', -200);
  const returning = invoke('drag-end', -160);
  advance(64);
  screen.emit('display-metrics-changed');
  assert.equal((await returning).value, false);
  assert.deepEqual(win.bounds, origin);
  assert.equal(animations.size, 0);
  await invoke('drag-start', -200);
  const closing = invoke('drag-end', -80);
  advance(64);
  manager.show([article('2')]);
  manager.dispose();
  assert.equal((await closing).value, false);
  assert.equal(win.destroyed, true);
  assert.equal(animations.size, 0);
  advance(500);
  assert.equal(windows.length, 1);
});

test('interest filtering runs before window creation and grouped totals, while previews bypass the filter', async (t) => {
  let keywords = ['SSD'];
  const { manager, windows, invoke } = fixture(t, { filterArticles: (posts) => posts.filter(createInterestMatcher(keywords)) });
  manager.show([article('1', { title: '생수' })]);
  assert.equal(windows.length, 0);
  manager.show([article('2', { title: 'SSD 1TB' }), article('3', { title: '생수' }), article('4', { title: 'ssd 2TB' })]);
  assert.equal(windows.length, 1);
  windows[0].emit('ready-to-show');
  const payload = (await invoke('ready')).value;
  assert.equal(payload.total, 2);
  assert.deepEqual(payload.articles.map(({ id }) => id), ['4', '2']);
  manager.dismiss();
  keywords = [];
  manager.show([article('5', { title: 'SSD' })]);
  assert.equal(windows.length, 1);
  manager.showDemo();
  assert.equal(windows.length, 2);
  assert.equal((await invoke('ready')).value.test, true);
});

test('interests are checked again for queued arrivals after the dismiss animation', async (t) => {
  let allowed = true;
  const { manager, windows, invoke, advance } = fixture(t, { filterArticles: (posts) => allowed ? posts : [] });
  manager.show([article('1')]); windows[0].emit('ready-to-show');
  await invoke('drag-start', -200);
  const closing = invoke('drag-end', -80);
  manager.show([article('2')]);
  allowed = false;
  advance(300);
  await closing;
  assert.equal(windows.length, 1);
  assert.equal(windows[0].destroyed, true);
});
