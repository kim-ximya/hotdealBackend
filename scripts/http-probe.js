// Run separately from the existing backend: node scripts/http-probe.js
// Optional ARCA_COOKIE, ARCA_USER_AGENT and ARCA_AUTHORIZATION environment variables.
// Sends one GET without following redirects or printing the supplied credentials.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const url = 'https://arca.live/b/hotdeal';
const outputDirectory = resolve(import.meta.dirname, '..', '.local', 'http-probe');
const filename = new Date().toISOString().replace(/[:.]/g, '-');
const maxBytes = 2 * 1024 * 1024;
const startedAt = Date.now();
const cookie = process.env.ARCA_COOKIE?.trim() || '';
const authorization = process.env.ARCA_AUTHORIZATION?.trim() || '';
const userAgent = process.env.ARCA_USER_AGENT?.trim() || 'hotdeal-backend-http-probe/0.1';
const redact = (message) => {
  if (message == null) return null;
  let result = String(message);
  for (const secret of [cookie, authorization]) {
    if (secret) result = result.replaceAll(secret, '[REDACTED]');
  }
  return result;
};

try {
  for (const [name, value] of Object.entries({ ARCA_COOKIE: cookie, ARCA_AUTHORIZATION: authorization, ARCA_USER_AGENT: userAgent })) {
    if (/[^\x20-\x7E\t]/.test(value)) throw new Error(`${name}에는 줄바꿈이나 비ASCII 문자를 넣을 수 없습니다. 요청 헤더 값 한 줄만 복사하세요.`);
  }
  const headers = { Accept: 'text/html', 'User-Agent': userAgent };
  if (cookie) headers.Cookie = cookie;
  if (authorization) headers.Authorization = authorization;
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  const chunks = [];
  let bytes = 0;
  let truncated = false;
  if (response.body) {
    for await (const chunk of response.body) {
      const remaining = maxBytes - bytes;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining) {
        truncated = true;
        break;
      }
    }
  }
  const body = Buffer.concat(chunks);
  const html = body.toString('utf8');
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1].replace(/\s+/g, ' ').trim() || null;
  const classContains = (name) => new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${name}\\b[^"']*["']`, 'i').test(html);
  const hasArticleList = classContains('article-list') && classContains('list-table');
  const challenge = response.headers.get('cf-mitigated') === 'challenge';
  const htmlResponse = /^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '');
  const listDetected = response.ok && htmlResponse && !challenge && hasArticleList && !truncated;
  const htmlPath = resolve(outputDirectory, `${filename}.html`);
  const reportPath = resolve(outputDirectory, `${filename}.json`);
  const report = {
    requestedUrl: url,
    requestOptions: {
      cookieProvided: Boolean(cookie),
      authorizationProvided: Boolean(authorization),
      customUserAgent: Boolean(process.env.ARCA_USER_AGENT?.trim()),
    },
    checkedAt: new Date().toISOString(),
    httpStatus: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(['content-type', 'server', 'cf-mitigated', 'cf-ray', 'retry-after']
      .map((name) => [name, response.headers.get(name)])),
    elapsedMs: Date.now() - startedAt,
    savedBytes: body.byteLength,
    truncated,
    title,
    hasArticleList,
    listDetected,
    htmlPath,
  };

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(htmlPath, body);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`진단 파일: ${reportPath}`);
  if (listDetected) {
    console.log('게시글 목록 HTML의 구조를 확인했습니다. 게시글 필드 파싱은 별도로 검증해야 합니다.');
  } else {
    console.log('HTTP 응답은 받았지만 정상적인 게시글 목록 HTML은 확인하지 못했습니다.');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({
    requestedUrl: url,
    elapsedMs: Date.now() - startedAt,
    error: redact(error.message),
    cause: redact(error.cause?.message),
    code: error.cause?.code || error.code || null,
  }, null, 2));
  process.exitCode = 1;
}
