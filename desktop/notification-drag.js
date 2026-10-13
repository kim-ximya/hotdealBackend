export function bindNotificationDrag(card, api, onError) {
  let gesture = null;
  let frame = null;
  let suppressClick = false;
  let finishing = false;
  const stopFrame = () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; };
  const report = (error) => { onError(error); };

  function finish(event, cancelled = false) {
    if (!gesture || (event.pointerId !== undefined && event.pointerId !== gesture.id)) return;
    const current = gesture;
    gesture = null;
    stopFrame();
    card.classList.remove('is-dragging');
    if (current.target.hasPointerCapture(current.id)) current.target.releasePointerCapture(current.id);
    if (current.moved) {
      suppressClick = true;
      // The click synthesized after pointerup must never open an article or a button.
      setTimeout(() => { suppressClick = false; }, 0);
    }
    if (!current.started) return;
    finishing = true;
    current.ready.then(() => cancelled ? api.cancelDrag() : api.endDrag(event.screenX))
      .then((dismissed) => { if (!dismissed) return api.hover(document.body.matches(':hover')); })
      .catch(report).finally(() => { finishing = false; });
  }

  card.addEventListener('pointerdown', (event) => {
    if (finishing || gesture || event.button !== 0 || event.isPrimary === false || event.target.closest('#close, #open-list')) return;
    // Capture on the original button so a normal click keeps its target, while
    // pointerup is still delivered after the mouse leaves the notification.
    const target = event.target.closest('button') || card;
    target.setPointerCapture(event.pointerId);
    gesture = { id: event.pointerId, target, startX: event.screenX, startY: event.screenY,
      x: event.screenX, started: false, moved: false };
  });
  card.addEventListener('pointermove', (event) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    gesture.x = event.screenX;
    if (Math.hypot(event.screenX - gesture.startX, event.screenY - gesture.startY) >= 8) gesture.moved = true;
    if (!gesture.started) {
      const dx = event.screenX - gesture.startX;
      if (dx < 8 || dx < Math.abs(event.screenY - gesture.startY)) return;
      gesture.started = true;
      suppressClick = true;
      card.classList.add('is-dragging');
      gesture.ready = api.beginDrag(gesture.startX);
      gesture.ready.catch((error) => { finish({ pointerId: event.pointerId }, true); report(error); });
    }
    event.preventDefault();
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const current = gesture;
      if (!current?.started) return;
      current.ready.then(() => api.moveDrag(current.x)).catch((error) => {
        finish({ pointerId: current.id }, true);
        report(error);
      });
    });
  });
  window.addEventListener('pointerup', (event) => finish(event));
  window.addEventListener('pointercancel', (event) => finish(event, true));
  window.addEventListener('lostpointercapture', (event) => finish(event, true));
  window.addEventListener('blur', () => finish({}, true));
  card.addEventListener('dragstart', (event) => event.preventDefault());
  card.addEventListener('click', (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
