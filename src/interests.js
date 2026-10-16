export const MAX_INTERESTS = 100;
export const MAX_KEYWORD_LENGTH = 80;
export const interestKey = (value) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export function normalizeKeywords(value) {
  if (!Array.isArray(value) || value.length > MAX_INTERESTS) throw new Error(`관심 품목은 최대 ${MAX_INTERESTS}개까지 등록할 수 있습니다.`);
  const unique = new Map();
  for (const keyword of value) {
    if (typeof keyword !== 'string' || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new Error('관심 품목은 줄바꿈 없는 텍스트로 입력하세요.');
    const text = keyword.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (!text || text.length > MAX_KEYWORD_LENGTH) throw new Error(`관심 품목은 1~${MAX_KEYWORD_LENGTH}자로 입력하세요.`);
    if (!unique.has(interestKey(text))) unique.set(interestKey(text), text);
  }
  return [...unique.values()];
}

export function createInterestMatcher(keywords) {
  const keys = normalizeKeywords(keywords).map(interestKey);
  return (article) => {
    const title = typeof article?.title === 'string' ? interestKey(article.title) : '';
    return keys.some((key) => title.includes(key));
  };
}

export function selectArticles(snapshot, { limit, offset, keywords }) {
  const articles = keywords === undefined ? snapshot.articles : snapshot.articles.filter(createInterestMatcher(keywords));
  const page = articles.slice(offset, offset + limit);
  return { ...snapshot, allTotal: snapshot.total, total: articles.length,
    limit, offset, articles: page, returnedCount: page.length };
}
