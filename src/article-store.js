import { mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SOURCE_URL } from './article-parser.js';

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
  } finally {
    if (file) await file.close().catch(() => {});
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

function validArticle(article) {
  return article && typeof article === 'object' &&
    typeof article.id === 'string' && /^\d{1,30}$/.test(article.id) &&
    article.url === `${SOURCE_URL}/${article.id}` && typeof article.title === 'string' && article.title.trim() &&
    (article.author === null || typeof article.author === 'string');
}

const newestFirst = (a, b) => BigInt(a.id) === BigInt(b.id) ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1;

export class ArticleStore {
  #path;
  #maxArticles;
  #write;
  #snapshot = { schemaVersion: 1, channel: '/b/hotdeal', sourceUrl: SOURCE_URL, updatedAt: null, latestCount: 0, total: 0, articles: [] };

  constructor({ path, maxArticles = 10000, write = atomicWriteJson }) {
    if (!Number.isInteger(maxArticles) || maxArticles < 1 || maxArticles > 100000) throw new Error('MAX_ARTICLES는 1~100000 사이의 정수여야 합니다.');
    this.#path = path;
    this.#maxArticles = maxArticles;
    this.#write = write;
  }

  get path() { return this.#path; }
  getSnapshot() { return structuredClone(this.#snapshot); }

  async load() {
    let data;
    try {
      if ((await stat(this.#path)).size > 64 * 1024 * 1024) throw new Error('저장된 게시글 JSON이 64 MiB를 초과합니다.');
      data = JSON.parse(await readFile(this.#path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error(`게시글 JSON을 읽지 못했습니다. 기존 파일을 보존합니다: ${error.message}`);
    }
    if (data?.schemaVersion !== 1 || data.channel !== '/b/hotdeal' || data.sourceUrl !== SOURCE_URL ||
      !Array.isArray(data.articles) || !data.articles.every(validArticle) ||
      typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt)) ||
      !Number.isInteger(data.latestCount) || data.latestCount < 0) {
      throw new Error('저장된 게시글 JSON 형식이 올바르지 않습니다. 기존 파일을 보존합니다.');
    }
    const articles = [...new Map(data.articles.map((article) => [article.id, article])).values()]
      .filter((article) => !article.author?.trim().startsWith('*'))
      .sort(newestFirst).slice(0, this.#maxArticles);
    this.#snapshot = { ...this.#snapshot, updatedAt: data.updatedAt, latestCount: data.latestCount, total: articles.length, articles };
  }

  async save(collected, collectedAt = new Date().toISOString()) {
    if (!Array.isArray(collected) || !collected.every(validArticle)) throw new Error('수집된 게시글 형식이 올바르지 않습니다.');
    const merged = new Map(this.#snapshot.articles.map((article) => [article.id, article]));
    const latest = new Map(collected.map((article) => [article.id, article]));
    let addedCount = 0;
    for (const article of latest.values()) {
      if (article.author?.trim().startsWith('*')) { merged.delete(article.id); continue; }
      const previous = merged.get(article.id);
      if (!previous) addedCount++;
      merged.set(article.id, {
        ...article, firstSeenAt: previous?.firstSeenAt || collectedAt, lastSeenAt: collectedAt,
      });
    }
    const articles = [...merged.values()].sort(newestFirst).slice(0, this.#maxArticles);
    const snapshot = { ...this.#snapshot, updatedAt: collectedAt,
      latestCount: [...latest.values()].filter((article) => !article.author?.trim().startsWith('*')).length,
      total: articles.length, articles };
    await this.#write(this.#path, snapshot);
    this.#snapshot = snapshot;
    return { addedCount, collectedCount: snapshot.latestCount, storedCount: snapshot.total, updatedAt: collectedAt };
  }
}
