// ==UserScript==
// @name         Hotdeal Backend Relay
// @namespace    hotdeal-backend-local
// @version      0.3.0
// @description  핫딜 채널의 na 알림과 HTTP 목록 HTML을 로컬 백엔드로 전달합니다.
// @match        https://arca.live/b/hotdeal*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(() => {
  'use strict';
  if (!/^\/b\/hotdeal(?:\/|$)/.test(location.pathname)) return;
  const CONFIG = /*__RELAY_CONFIG__*/ null;
  if (!CONFIG) {
    console.error('[Hotdeal Relay] 로컬 백엔드의 설치 주소에서 스크립트를 설치하세요.');
    return;
  }

  const NativeWebSocket = unsafeWindow.WebSocket;
  const clientId = crypto.randomUUID();
  const queue = [];
  let sequence = 0;
  let socketState = 'waiting';
  let activeSocket = null;
  let inFlight = false;
  let retryTimer = null;
  let paused = false;
  let fetchPending = false;
  let fetchInFlight = false;
  let fetchTimer = null;
  let fetchBlocked = false;
  let lastFetchStarted = -Infinity;
  let pendingTrigger = 'initial';

  function flush() {
    if (paused || inFlight || retryTimer !== null || !queue.length) return;
    inFlight = true;
    const event = queue[0];
    const retry = () => {
      if (!inFlight) return;
      inFlight = false;
      console.warn('[Hotdeal Relay] 백엔드에 연결하지 못했습니다. 5초 후 다시 전달합니다.');
      retryTimer = setTimeout(() => {
        retryTimer = null;
        flush();
      }, 5000);
    };
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: event.type === 'html' ? CONFIG.htmlEndpoint : CONFIG.endpoint,
        anonymous: true,
        timeout: 5000,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.token}` },
        data: JSON.stringify(event),
        onload(response) {
          if (response.status === 401) {
            inFlight = false;
            paused = true;
            console.error('[Hotdeal Relay] 인증 실패. 백엔드에서 스크립트를 다시 설치한 뒤 핫딜 탭을 새로고침하세요.');
            return;
          }
          if (response.status < 200 || response.status >= 300) {
            if ([400, 413, 415, 422].includes(response.status)) {
              console.error(`[Hotdeal Relay] 백엔드가 이벤트를 거부했습니다 (HTTP ${response.status}). /api/status의 collection.lastError를 확인하세요.`);
              inFlight = false;
              queue.shift();
              flush();
              return;
            }
            retry();
            return;
          }
          inFlight = false;
          const index = queue.indexOf(event);
          if (index !== -1) queue.splice(index, 1);
          flush();
        },
        onerror: retry,
        ontimeout: retry,
        onabort: retry,
      });
    } catch {
      retry();
    }
  }

  function relay(type, payload = {}) {
    if (paused) return;
    if (type === 'heartbeat' && queue.some((event) => event.type === 'heartbeat')) return;
    // Only the latest unsent snapshot is useful; never replace an in-flight request.
    if (type === 'html') {
      for (let index = queue.length - 1; index > 0; index--) {
        if (queue[index].type === 'html') queue.splice(index, 1);
      }
    }
    if (queue.length >= 100) {
      // Keep the head until acknowledged; its request may have reached the backend already.
      let index = queue.findIndex((event, i) => i > 0 && event.type !== 'na');
      if (index === -1) index = 1;
      queue.splice(index, 1);
      console.warn('[Hotdeal Relay] 전송 대기열이 가득 차 오래된 대기 알림을 버렸습니다.');
    }
    queue.push({ ...payload, type, channel: '/b/hotdeal', socketState, clientId,
      eventId: `${clientId}:${++sequence}`, receivedAt: new Date().toISOString() });
    flush();
  }

  function requestList(trigger) {
    if (paused || fetchBlocked) return;
    fetchPending = true;
    if (trigger === 'na') pendingTrigger = 'na';
    scheduleFetch();
  }

  function scheduleFetch() {
    if (paused || fetchBlocked || !fetchPending || fetchInFlight || fetchTimer !== null) return;
    // A short trailing window batches bursts; request starts are at least 3 seconds apart.
    const delay = Math.max(250, 3000 - (Date.now() - lastFetchStarted));
    fetchTimer = setTimeout(() => {
      fetchTimer = null;
      void fetchList();
    }, delay);
  }

  async function fetchList() {
    if (paused || fetchBlocked || !fetchPending) return;
    fetchInFlight = true;
    fetchPending = false;
    const trigger = pendingTrigger;
    pendingTrigger = 'initial';
    lastFetchStarted = Date.now();
    let httpStatus = null;
    try {
      const response = await unsafeWindow.fetch(CONFIG.sourceUrl, {
        method: 'GET', credentials: 'same-origin', cache: 'no-cache',
        headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15_000),
      });
      httpStatus = response.status;
      if (response.headers.get('cf-mitigated') === 'challenge' || [401, 403, 429].includes(response.status)) {
        fetchBlocked = true;
        fetchPending = false;
        throw new Error('목록 요청이 제한됐습니다. 브라우저에서 핫딜 채널을 확인하고 필요하면 보안 확인을 완료한 뒤 새로고침하세요.');
      }
      if (!response.ok) throw new Error(`목록 HTTP 요청 실패: ${response.status}`);
      const finalUrl = new URL(response.url || CONFIG.sourceUrl);
      if (finalUrl.origin !== 'https://arca.live' || finalUrl.pathname.replace(/\/$/, '') !== '/b/hotdeal' || finalUrl.search) {
        throw new Error('목록이 아닌 페이지로 이동했습니다. 핫딜 채널 접속 상태를 확인하세요.');
      }
      if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        throw new Error('HTML이 아닌 응답을 받았습니다.');
      }
      if (Number(response.headers.get('content-length')) > CONFIG.maxHtmlBytes) {
        await response.body?.cancel();
        throw new Error('목록 HTML이 1 MiB를 초과합니다.');
      }
      const html = await response.text();
      if (new TextEncoder().encode(html).length > CONFIG.maxHtmlBytes) throw new Error('목록 HTML이 1 MiB를 초과합니다.');
      relay('html', { html, sourceUrl: CONFIG.sourceUrl, trigger });
    } catch (error) {
      const message = String(error.message || error).slice(0, 300);
      console.error(`[Hotdeal Relay] ${message}`);
      relay('fetchError', { message, httpStatus });
    } finally {
      fetchInFlight = false;
      scheduleFetch();
    }
  }

  unsafeWindow.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      let url;
      try { url = new URL(args[0], location.href); } catch { return socket; }
      if (url.origin !== 'wss://arca.live' || url.pathname !== '/arcalive') return socket;

      let subscribed = false;
      const originalSend = socket.send;
      socket.send = function (data) {
        const result = Reflect.apply(originalSend, this, [data]);
        if (typeof data === 'string' && data.startsWith('c|')) {
          subscribed = data === 'c|/b/hotdeal';
          if (subscribed) {
            activeSocket = socket;
            socketState = 'subscribed';
            relay('subscribed');
          } else if (activeSocket === socket) {
            activeSocket = null;
            socketState = 'waiting';
          }
        }
        return result;
      };
      socket.addEventListener('message', ({ data }) => {
        if (!subscribed || activeSocket !== socket) return;
        socketState = 'receiving';
        if (data === 'na') {
          console.info('[Hotdeal Relay] 새 글 알림(na) 감지');
          relay('na');
          requestList('na');
        }
      });
      socket.addEventListener('close', () => {
        if (!subscribed || activeSocket !== socket) return;
        socketState = 'closed';
        relay('disconnected');
      });
      socket.addEventListener('error', () => {
        if (!subscribed || activeSocket !== socket) return;
        socketState = 'error';
        relay('socketError');
      });
      return socket;
    },
  });

  relay('ready');
  setInterval(() => relay('heartbeat'), 15_000);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => requestList('initial'), { once: true });
  } else {
    requestList('initial');
  }
  console.info('[Hotdeal Relay] 준비 완료. 핫딜 채널의 WebSocket 구독을 기다립니다.');
})();
