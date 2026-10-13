import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNotificationDrag } from '../desktop/notification-drag.js';

class Surface {
  handlers = new Map();
  capture = new Set();
  classList = { add: () => {}, remove: () => {} };
  addEventListener(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(handler);
  }
  fire(name, props = {}) {
    const event = { pointerId: 1, button: 0, isPrimary: true, screenX: 100, screenY: 50,
      target: this, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...props };
    for (const handler of this.handlers.get(name) || []) handler(event);
    return event;
  }
  closest() { return null; }
  setPointerCapture(id) { this.capture.add(id); }
  hasPointerCapture(id) { return this.capture.has(id); }
  releasePointerCapture(id) { this.capture.delete(id); }
}

function fixture(t) {
  const globals = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const card = new Surface(); const surface = new Surface(); const button = new Surface();
  button.closest = (selector) => selector === 'button' ? button : null;
  const frames = new Map(); let frameId = 0;
  globalThis.window = surface;
  globalThis.document = { body: { matches: () => false } };
  globalThis.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  t.after(() => globals.forEach((key, index) => {
    if (previous[index]) Object.defineProperty(globalThis, key, previous[index]); else delete globalThis[key];
  }));
  const calls = []; const errors = [];
  const api = Object.fromEntries(['beginDrag', 'moveDrag', 'endDrag', 'cancelDrag', 'hover'].map((name) => [name, async (value) => {
    calls.push([name, value]); return false;
  }]));
  bindNotificationDrag(card, api, (error) => errors.push(error));
  return { card, surface, button, calls, errors, frames, flush: () => {
    for (const [id, callback] of frames) { frames.delete(id); callback(); }
  } };
}
const settle = () => new Promise(setImmediate);

test('ordinary article clicks retain their target and do not start dragging', async (t) => {
  const { card, surface, button, calls } = fixture(t);
  card.fire('pointerdown', { target: button });
  assert.equal(button.hasPointerCapture(1), true);
  card.fire('pointermove', { target: button, screenX: 103 });
  surface.fire('pointerup', { target: button, screenX: 103 });
  assert.equal(button.hasPointerCapture(1), false);
  assert.equal(card.fire('click', { target: button }).prevented, false);
  await settle();
  assert.deepEqual(calls, []);
});

test('swiping an article moves once per frame, uses release coordinates and suppresses opening the article', async (t) => {
  const { card, surface, button, calls, errors, flush } = fixture(t);
  card.fire('pointerdown', { target: button });
  card.fire('pointermove', { target: button, screenX: 120 });
  card.fire('pointermove', { target: button, screenX: 150 });
  flush(); await settle();
  surface.fire('pointerup', { target: button, screenX: 220 });
  const click = card.fire('click', { target: button });
  assert.equal(click.prevented, true); assert.equal(click.stopped, true);
  await settle();
  assert.deepEqual(calls, [['beginDrag', 100], ['moveDrag', 150], ['endDrag', 220], ['hover', false]]);
  assert.deepEqual(errors, []);
});

test('pointer cancellation cancels a swipe and leaves no queued movement', async (t) => {
  const { card, surface, button, calls, frames, errors } = fixture(t);
  card.fire('pointerdown', { target: button });
  card.fire('pointermove', { target: button, screenX: 150 });
  surface.fire('pointercancel', { target: button });
  await settle();
  assert.equal(frames.size, 0);
  assert.deepEqual(calls, [['beginDrag', 100], ['cancelDrag', undefined], ['hover', false]]);
  assert.equal(button.hasPointerCapture(1), false);
  assert.deepEqual(errors, []);
});

test('close and list buttons stay clickable, while left or vertical drags do not accidentally open an article', async (t) => {
  const { card, surface, button, calls } = fixture(t);
  const control = new Surface();
  control.closest = () => control;
  card.fire('pointerdown', { target: control });
  card.fire('pointermove', { target: control, screenX: 180 });
  surface.fire('pointerup', { target: control, screenX: 180 });
  assert.equal(card.fire('click', { target: control }).prevented, false);
  card.fire('pointerdown', { target: button });
  card.fire('pointermove', { target: button, screenX: 60 });
  surface.fire('pointerup', { target: button, screenX: 60 });
  assert.equal(card.fire('click', { target: button }).prevented, true);
  await settle();
  assert.deepEqual(calls, []);
});
