import { createServer } from 'node:http';
import { validInterval } from './crawl-service.js';

export class CrawlerApi {
  #server;
  #service;
  #store;
  #port;
  #origins;

  constructor({ service, store, port = 38471, allowedOrigins = [] }) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT가 올바르지 않습니다.');
    for (const origin of allowedOrigins) {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('FRONTEND_ORIGINS에는 정확한 HTTP(S) 출처만 지정하세요.');
    }
    this.#service = service;
    this.#store = store;
    this.#port = port;
    this.#origins = new Set(allowedOrigins);
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        if (!response.headersSent && !response.destroyed) this.#reply(request, response, 500, { error: error.message });
        else response.destroy();
      });
    });
    this.#server.requestTimeout = 10000;
    this.#server.headersTimeout = 10000;
  }

  get baseUrl() {
    const address = this.#server.address();
    if (!address) throw new Error('API 서버가 실행 중이 아닙니다.');
    return `http://127.0.0.1:${address.port}`;
  }

  async start() {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.#server.once('error', onError);
      this.#server.listen(this.#port, '127.0.0.1', () => {
        this.#server.off('error', onError);
        resolve();
      });
    });
  }

  async stop() {
    if (!this.#server.listening) return;
    await new Promise((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
      this.#server.closeAllConnections();
    });
  }

  #originAllowed(origin) {
    return !origin || origin === this.baseUrl || this.#origins.has(origin);
  }

  #reply(request, response, status, body, contentType = 'application/json; charset=utf-8') {
    const headers = {
      'Content-Type': contentType, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      Vary: 'Origin',
    };
    const origin = request.headers.origin;
    if (origin && this.#originAllowed(origin)) headers['Access-Control-Allow-Origin'] = origin;
    if (request.method === 'OPTIONS' && status === 204) {
      headers['Access-Control-Allow-Methods'] = 'GET, PUT, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
    }
    response.writeHead(status, headers);
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  async #readJson(request) {
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      const error = new Error('application/json이 필요합니다.'); error.status = 415; throw error;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 4096) { const error = new Error('요청이 너무 큽니다.'); error.status = 413; throw error; }
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { const error = new Error('JSON 형식이 올바르지 않습니다.'); error.status = 400; throw error; }
  }

  async #handle(request, response) {
    const reply = (status, body, contentType) => this.#reply(request, response, status, body, contentType);
    if (request.headers.host !== new URL(this.baseUrl).host) { reply(403, { error: '허용되지 않은 Host' }); return; }
    if (!this.#originAllowed(request.headers.origin)) { reply(403, { error: '허용되지 않은 Origin' }); return; }
    const url = new URL(request.url, this.baseUrl);
    const path = url.pathname;
    const knownApi = ['/api/articles', '/api/status', '/api/settings', '/api/collect'].includes(path);
    if (request.method === 'OPTIONS' && knownApi) { reply(204, ''); return; }
    if (request.method === 'GET' && path === '/') {
      reply(200, `<!doctype html><html lang="ko"><meta charset="utf-8"><title>핫딜 수집 서버</title>
<h1>Selenium 핫딜 수집 서버</h1><p>설정한 간격으로 목록을 수집해 JSON 파일로 저장합니다.</p>
<ul><li><a href="/api/articles">저장된 게시글 목록</a></li><li><a href="/api/status">수집 상태</a></li><li><a href="/api/settings">현재 수집 간격</a></li></ul>
<p>간격 변경: PUT /api/settings 에 JSON {"intervalSeconds":180}을 전달하세요.</p>
<p>즉시 수집: POST /api/collect 에 JSON {}을 전달하세요.</p></html>`, 'text/html; charset=utf-8');
      return;
    }
    if (request.method === 'GET' && path === '/api/status') { reply(200, this.#service.getStatus()); return; }
    if (request.method === 'GET' && path === '/api/settings') { reply(200, { intervalSeconds: this.#service.getStatus().intervalSeconds }); return; }
    if (request.method === 'GET' && path === '/api/articles') {
      const limitText = url.searchParams.get('limit') ?? '100';
      const offsetText = url.searchParams.get('offset') ?? '0';
      const limit = Number(limitText);
      const offset = Number(offsetText);
      if (!/^\d+$/.test(limitText) || !/^\d+$/.test(offsetText) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) {
        reply(400, { error: 'limit는 1~1000, offset은 0 이상의 정수여야 합니다.' }); return;
      }
      const snapshot = this.#store.getSnapshot();
      const articles = snapshot.articles.slice(offset, offset + limit);
      reply(200, { ...snapshot, limit, offset, returnedCount: articles.length, articles });
      return;
    }
    if ((request.method === 'PUT' && path === '/api/settings') || (request.method === 'POST' && path === '/api/collect')) {
      let body;
      try { body = await this.#readJson(request); }
      catch (error) { request.resume(); reply(error.status || 400, { error: error.message }); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { reply(400, { error: 'JSON 객체가 필요합니다.' }); return; }
      if (path === '/api/settings') {
        if (!validInterval(body.intervalSeconds) || Object.keys(body).some((key) => key !== 'intervalSeconds')) {
          reply(400, { error: 'intervalSeconds에 1~86400 사이의 정수를 지정하세요.' }); return;
        }
        reply(200, await this.#service.setIntervalSeconds(body.intervalSeconds));
      } else {
        if (!this.#service.getStatus().running) { reply(503, { error: '수집 서버가 종료 중이거나 시작되지 않았습니다.' }); return; }
        const alreadyRunning = this.#service.getStatus().isCollecting;
        void this.#service.collectNow();
        reply(202, { accepted: true, alreadyRunning, statusUrl: '/api/status' });
      }
      return;
    }
    reply(404, { error: '경로를 찾을 수 없습니다.' });
  }
}
