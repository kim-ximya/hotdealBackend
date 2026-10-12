import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MAX_HTML_BYTES, parseArticleList, SOURCE_URL } from './article-parser.js';

const CHANNEL = '/b/hotdeal';
const TYPES = new Set(['ready', 'subscribed', 'heartbeat', 'disconnected', 'socketError', 'na', 'fetchError']);
const STATES = new Set(['waiting', 'subscribed', 'receiving', 'closed', 'error']);
const validToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);

export async function loadRelayToken(path) {
  await mkdir(dirname(path), { recursive: true });
  const read = async () => {
    const token = (await readFile(path, 'utf8')).trim();
    if (!validToken(token)) throw new Error('저장된 중계 인증값이 올바르지 않습니다.');
    return token;
  };
  try {
    return await read();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('base64url');
  try {
    await writeFile(path, token, { flag: 'wx', mode: 0o600 });
    return token;
  } catch (error) {
    if (error.code === 'EEXIST') return read();
    throw error;
  }
}

export function renderUserscript(template, { token, baseUrl }) {
  if (!validToken(token)) throw new Error('중계 인증값이 올바르지 않습니다.');
  const marker = '/*__RELAY_CONFIG__*/ null';
  if (!template.includes(marker)) throw new Error('유저스크립트 설정 위치를 찾지 못했습니다.');
  return template.replace(marker, JSON.stringify({
    endpoint: `${baseUrl}/api/relay`, htmlEndpoint: `${baseUrl}/api/html`, token,
    sourceUrl: SOURCE_URL, maxHtmlBytes: MAX_HTML_BYTES,
  }));
}

function reply(response, status, body, contentType = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(request, limit = 8192) {
  const chunks = [];
  let size = 0;
  // Keep the socket alive long enough to return 413 even for a streamed body.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('요청이 너무 큽니다.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('JSON 형식이 올바르지 않습니다.');
    error.status = 400;
    throw error;
  }
}

function validEvent(event, isHtml) {
  return event && typeof event === 'object' && !Array.isArray(event) &&
    event.channel === CHANNEL && (isHtml ? event.type === 'html' : TYPES.has(event.type)) && STATES.has(event.socketState) &&
    typeof event.clientId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(event.clientId) &&
    typeof event.eventId === 'string' && /^[A-Za-z0-9_:-]{1,100}$/.test(event.eventId) &&
    typeof event.receivedAt === 'string' && event.receivedAt.length <= 40 &&
    Number.isFinite(Date.parse(event.receivedAt)) &&
    (event.type !== 'fetchError' || (typeof event.message === 'string' && event.message.length <= 300 &&
      (event.httpStatus === null || (Number.isInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599)))) &&
    (!isHtml || (event.sourceUrl === SOURCE_URL && ['initial', 'na'].includes(event.trigger) &&
      typeof event.html === 'string' && Buffer.byteLength(event.html, 'utf8') <= MAX_HTML_BYTES));
}

export class BrowserRelay extends EventEmitter {
  #token;
  #port;
  #server;
  #template;
  #clients = new Map();
  #seen = new Set();
  #newArticleCount = 0;
  #lastNewArticleAt = null;
  #articles = [];
  #articlesUpdatedAt = null;
  #articlesFetchedAt = null;
  #lastCollectionTimestamp = -Infinity;
  #lastCollectionError = null;

  constructor({ token, port = 38471 }) {
    super();
    if (!validToken(token)) throw new Error('중계 인증값이 올바르지 않습니다.');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT가 올바르지 않습니다.');
    this.#token = token;
    this.#port = port;
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch(() => {
        if (!response.headersSent && !response.destroyed) reply(response, 500, { error: '서버 오류' });
        else response.destroy();
      });
    });
    this.#server.requestTimeout = 10_000;
    this.#server.headersTimeout = 10_000;
  }

  get baseUrl() {
    const address = this.#server.address();
    if (!address) throw new Error('백엔드가 실행 중이 아닙니다.');
    return `http://127.0.0.1:${address.port}`;
  }

  async start() {
    this.#template = await readFile(new URL('../browser/hotdeal-relay.user.js', import.meta.url), 'utf8');
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
    await new Promise((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
      this.#server.closeAllConnections();
    });
  }

  getStatus() {
    const now = Date.now();
    const clients = [...this.#clients.values()].map((client) => ({
      ...client,
      online: now - Date.parse(client.lastSeenAt) < 45_000,
    }));
    return {
      mode: 'browser-relay',
      channel: CHANNEL,
      browserOnline: clients.some((client) => client.online),
      socketReceiving: clients.some((client) => client.online && client.socketState === 'receiving'),
      newArticleCount: this.#newArticleCount,
      lastNewArticleAt: this.#lastNewArticleAt,
      collection: {
        articleCount: this.#articles.length,
        updatedAt: this.#articlesUpdatedAt,
        fetchedAt: this.#articlesFetchedAt,
        lastError: this.#lastCollectionError,
      },
      clients,
    };
  }

  getArticles() {
    return {
      channel: CHANNEL, sourceUrl: SOURCE_URL,
      updatedAt: this.#articlesUpdatedAt, fetchedAt: this.#articlesFetchedAt,
      total: this.#articles.length, articles: this.#articles,
    };
  }

  async #handle(request, response) {
    if (request.headers.host !== new URL(this.baseUrl).host) {
      reply(response, 403, { error: '허용되지 않은 Host' });
      return;
    }
    const path = new URL(request.url, this.baseUrl).pathname;
    if (request.method === 'GET' && path === '/') {
      reply(response, 200, `<!doctype html><html lang="ko"><meta charset="utf-8"><title>핫딜 브라우저 중계</title>
<h1>핫딜 브라우저 중계 백엔드</h1><ol>
<li>브라우저에 Tampermonkey 확장 프로그램을 설치합니다.</li>
<li><a href="/hotdeal-relay.user.js">유저스크립트를 설치합니다.</a> 코드가 표시되면 Tampermonkey의 새 스크립트 편집기에 전체를 복사해 저장하세요.</li>
<li>아카라이브 핫딜 채널을 새로고침하고 탭을 열어 둡니다.</li></ol>
<p><a href="/api/status">연결 상태 확인</a> · <a href="/api/articles">게시글 목록 JSON</a></p><p>이 컴퓨터의 브라우저에서 사용하세요. 설치 스크립트에는 인증값이 포함되므로 공유하지 마세요.</p></html>`, 'text/html; charset=utf-8');
      return;
    }
    if (request.method === 'GET' && path === '/hotdeal-relay.user.js') {
      // text/plain + nosniff prevents a remote page from loading the token-bearing source as a script.
      reply(response, 200, renderUserscript(this.#template, { token: this.#token, baseUrl: this.baseUrl }), 'text/plain; charset=utf-8');
      return;
    }
    if (request.method === 'GET' && path === '/api/status') {
      reply(response, 200, this.getStatus());
      return;
    }
    if (request.method === 'GET' && path === '/api/articles') {
      reply(response, 200, this.getArticles());
      return;
    }
    const isHtml = path === '/api/html';
    if (request.method !== 'POST' || (!isHtml && path !== '/api/relay')) {
      reply(response, 404, { error: '경로를 찾을 수 없습니다.' });
      return;
    }
    const expected = Buffer.from(`Bearer ${this.#token}`);
    const actual = Buffer.from(request.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      reply(response, 401, { error: '인증 실패. 백엔드에서 유저스크립트를 다시 설치하세요.' });
      return;
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      reply(response, 415, { error: 'application/json이 필요합니다.' });
      return;
    }
    let event;
    try {
      // JSON escaping can expand each HTML byte to six bytes.
      event = await readJson(request, isHtml ? MAX_HTML_BYTES * 6 + 8192 : 8192);
    } catch (error) {
      request.resume();
      reply(response, error.status || 400, { error: error.message });
      return;
    }
    if (!validEvent(event, isHtml)) {
      reply(response, 400, { error: '중계 이벤트 형식이 올바르지 않습니다.' });
      return;
    }
    if (this.#seen.has(event.eventId)) {
      reply(response, 200, { ok: true, duplicate: true });
      return;
    }
    this.#seen.add(event.eventId);
    if (this.#seen.size > 2048) this.#seen.delete(this.#seen.values().next().value);
    const receivedAt = new Date().toISOString();
    this.#clients.delete(event.clientId);
    this.#clients.set(event.clientId, { clientId: event.clientId, socketState: event.socketState, lastSeenAt: receivedAt });
    if (this.#clients.size > 16) this.#clients.delete(this.#clients.keys().next().value);
    if (event.type === 'na') {
      this.#newArticleCount += 1;
      this.#lastNewArticleAt = receivedAt;
      this.emit('newArticle', { channel: CHANNEL, receivedAt, browserReceivedAt: event.receivedAt });
    }
    if (isHtml || event.type === 'fetchError') {
      const fetchedTimestamp = Date.parse(event.receivedAt);
      if (fetchedTimestamp < this.#lastCollectionTimestamp) {
        reply(response, 200, { ok: true, ignored: true });
        return;
      }
      this.#lastCollectionTimestamp = fetchedTimestamp;
      if (event.type === 'fetchError') {
        this.#collectionFailed({ message: event.message, httpStatus: event.httpStatus, at: receivedAt });
      } else {
        let articles;
        try {
          articles = parseArticleList(event.html);
        } catch (error) {
          this.#collectionFailed({ message: error.message, httpStatus: null, at: receivedAt });
          reply(response, 422, { error: error.message });
          return;
        }
        this.#articles = articles;
        this.#articlesUpdatedAt = receivedAt;
        this.#articlesFetchedAt = event.receivedAt;
        this.#lastCollectionError = null;
        this.emit('articlesUpdated', { total: articles.length, receivedAt, trigger: event.trigger });
      }
    }
    this.emit('browserEvent', { type: event.type, socketState: event.socketState });
    reply(response, 200, { ok: true });
  }

  #collectionFailed(error) {
    this.#lastCollectionError = error;
    this.emit('collectionError', error);
  }
}
