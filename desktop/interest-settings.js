import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '../src/article-store.js';
import { normalizeKeywords, createInterestMatcher } from '../src/interests.js';

export const defaultInterestSettings = () => ({ keywords: [], notifyOnlyMatches: false });

export function validateInterestSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => !['keywords', 'notifyOnlyMatches'].includes(key)) || typeof value.notifyOnlyMatches !== 'boolean') {
    throw new Error('관심 품목 목록과 관심 품목만 알림 설정을 확인하세요.');
  }
  return { keywords: normalizeKeywords(value.keywords), notifyOnlyMatches: value.notifyOnlyMatches };
}

export class InterestSettings {
  #path;
  #write;
  #settings = defaultInterestSettings();
  #error = null;
  #pending = Promise.resolve();

  constructor(path, write = atomicWriteJson) { this.#path = path; this.#write = write; }

  async initialize() {
    try { this.#settings = validateInterestSettings(JSON.parse(await readFile(this.#path, 'utf8'))); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        // An unreadable allowlist must never broaden notifications to all posts.
        this.#settings = { keywords: [], notifyOnlyMatches: true };
        this.#error = `관심 품목 설정을 읽지 못했습니다. 기존 파일을 보존하고 새 글 알림을 차단합니다. 품목을 다시 등록해 복구하세요: ${error.message}`;
      }
    }
    return this.read();
  }

  read() { return { ...structuredClone(this.#settings), error: this.#error }; }

  save(value) {
    const settings = validateInterestSettings(value);
    const task = this.#pending.then(async () => {
      await this.#write(this.#path, settings);
      this.#settings = settings;
      this.#error = null;
      return this.read();
    });
    this.#pending = task.catch(() => {});
    return task;
  }

  filterNotifications(articles) {
    return this.#settings.notifyOnlyMatches ? articles.filter(createInterestMatcher(this.#settings.keywords)) : articles;
  }
}
