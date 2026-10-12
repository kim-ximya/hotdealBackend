import { load } from 'cheerio';

export const SOURCE_URL = 'https://arca.live/b/hotdeal';
export const MAX_HTML_BYTES = 1024 * 1024;

const text = (element) => element.text().replace(/\s+/g, ' ').trim() || null;

function articleId(href) {
  if (typeof href !== 'string') return null;
  try {
    const url = new URL(href, SOURCE_URL);
    return url.origin === 'https://arca.live' ? url.pathname.match(/^\/b\/hotdeal\/(\d+)\/?$/)?.[1] || null : null;
  } catch {
    return null;
  }
}

function count(value) {
  if (!value) return null;
  const normalized = value.replace(/[,\s\[\]]/g, '');
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)([kKmM만]?)$/);
  if (!match) return null;
  const multiplier = { k: 1000, m: 1_000_000, '만': 10_000 }[match[2].toLowerCase()] || 1;
  const result = Number(match[1]) * multiplier;
  return Number.isSafeInteger(result) ? result : null;
}

export function parseArticleList(html) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('목록 HTML이 비어 있습니다.');
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('목록 HTML이 1 MiB를 초과합니다.');
  const $ = load(html);
  const table = $('.article-list .list-table').first();
  if (!table.length) throw new Error('게시글 목록 영역을 찾지 못했습니다. 보안 확인·로그인 화면 또는 HTML 구조 변경을 확인하세요.');

  const rows = table.find('.vrow').not('.head, .notice-unfilter');
  const articles = [];
  const seen = new Set();
  const missingTitles = new Set();
  rows.each((_, element) => {
    const row = $(element);
    const links = row.is('a[href]') ? row : row.find('a.title[href], .col-title a[href]');
    // Hybrid rows put a category link before the post link. A selector list is
    // returned in document order, so validate the destination before taking first().
    const link = links.filter((_, anchor) => articleId($(anchor).attr('href')) !== null).first();
    const id = articleId(link.attr('href'));
    if (!id || seen.has(id)) return;

    let titleElement = row.find('.title').not('.hybrid-bottom, .preview-image').first();
    if (!titleElement.length) titleElement = row.find('.col-title').first();
    const titleCopy = titleElement.clone();
    titleCopy.find('.badges, .badge, .deal-store, .category, .info, .media-icon, .comment-count, .col-comment, .icons, .icon, i, svg, script, style').remove();
    const title = text(titleCopy);
    const isNotice = row.hasClass('notice') || row.hasClass('notice-service');
    if (!title) {
      if (!isNotice) missingTitles.add(id);
      return;
    }

    const time = row.find('time[datetime], .col-time time').first();
    const timeColumn = row.find('.col-time').first();
    const author = row.find('.col-author .user-info, .col-author .member-info, .col-author, .user-info, .member-info').first();
    seen.add(id);
    missingTitles.delete(id);
    articles.push({
      id,
      url: `https://arca.live/b/hotdeal/${id}`,
      title,
      category: text(row.find('.col-title .badge, .title .badge, .category, .badge').first()),
      author: text(author),
      createdAt: time.attr('datetime') || timeColumn.attr('data-original-title') || timeColumn.attr('title') || text(timeColumn),
      views: count(text(row.find('.col-view, .col-views').first())),
      recommendations: count(text(row.find('.col-rate, .col-recommend').first())),
      commentCount: count(text(row.find('.comment-count, .col-comment').first())),
      isNotice,
    });
  });
  if (missingTitles.size) throw new Error(`일반 게시글 ${missingTitles.size}개의 제목을 추출하지 못했습니다. HTML 구조를 확인하세요.`);
  if (rows.length && !articles.length) throw new Error('목록에서 게시글을 추출하지 못했습니다. HTML 구조를 확인하세요.');
  // Author text is already trimmed; staff names beginning with * are excluded.
  return articles.filter(({ author }) => !author?.startsWith('*'));
}
