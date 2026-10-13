const PAGE_SIZE = 50;
const $ = (id) => document.getElementById(id);
const number = (value) => Number.isFinite(value) ? value.toLocaleString('ko-KR') : '—';
const timestamp = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
};

export class ArticleListView {
  #api;
  #page = 1;
  #displayedPage = 1;
  #total = 0;
  #request = 0;
  #loading = false;
  #context = null;
  #requestedContext = null;
  #source = null;
  #hasData = false;

  constructor(api) {
    this.#api = api;
    $('refresh-articles').addEventListener('click', () => { void this.#load(); });
    $('articles-prev').addEventListener('click', () => { if (this.#page > 1 && !this.#loading) { this.#page--; void this.#load(); } });
    $('articles-next').addEventListener('click', () => { if (this.#page * PAGE_SIZE < this.#total && !this.#loading) { this.#page++; void this.#load(); } });
  }

  sync(snapshot) {
    const source = snapshot.phase === 'running' ? snapshot.baseUrl : `file:${snapshot.dataDirectory}`;
    if (source !== this.#source) this.#page = 1;
    this.#source = source;
    this.#context = `${source}/${snapshot.status?.lastSuccessAt}/${snapshot.status?.articleCount}`;
    if (this.#context !== this.#requestedContext) void this.#load();
  }

  #controls() {
    $('refresh-articles').disabled = this.#loading;
    $('articles-prev').disabled = this.#loading || this.#page <= 1;
    $('articles-next').disabled = this.#loading || this.#page * PAGE_SIZE >= this.#total;
    $('articles-page').textContent = `${this.#page} / ${Math.max(1, Math.ceil(this.#total / PAGE_SIZE))}`;
    $('articles-region').setAttribute('aria-busy', String(this.#loading));
  }

  async #load() {
    if (!this.#context) return;
    const request = ++this.#request;
    const context = this.#context;
    this.#requestedContext = context;
    this.#loading = true;
    $('articles-error').hidden = true;
    this.#controls();
    try {
      const snapshot = await this.#api.articles({ limit: PAGE_SIZE, offset: (this.#page - 1) * PAGE_SIZE });
      if (request !== this.#request) return;
      if (context !== this.#context) return;
      if (!snapshot || !Array.isArray(snapshot.articles) || !Number.isSafeInteger(snapshot.total) || snapshot.total < 0) throw new Error('게시글 목록 응답이 올바르지 않습니다.');
      this.#total = snapshot.total;
      const lastPage = Math.max(1, Math.ceil(this.#total / PAGE_SIZE));
      if (this.#page > lastPage) { this.#page = lastPage; void this.#load(); return; }
      this.#render(snapshot);
    } catch (error) {
      if (request !== this.#request) return;
      $('articles-error').textContent = `목록을 읽지 못했습니다: ${error.message}`;
      $('articles-error').hidden = false;
      if (this.#hasData) this.#page = this.#displayedPage;
      if (!this.#hasData) this.#empty('목록을 불러오지 못했습니다.', '목록 새로고침을 눌러 다시 시도하세요.');
    } finally {
      if (request === this.#request) { this.#loading = false; this.#controls(); }
    }
  }

  #empty(title, description) {
    const icon = document.createElement('span'); icon.textContent = '▤'; icon.setAttribute('aria-hidden', 'true');
    const heading = document.createElement('strong'); heading.textContent = title;
    const detail = document.createElement('p'); detail.textContent = description;
    $('articles-empty').replaceChildren(icon, heading, detail);
    $('articles-empty').hidden = false;
    $('articles-table').hidden = true;
  }

  #render(snapshot) {
    this.#displayedPage = this.#page;
    this.#hasData = snapshot.articles.length > 0;
    $('deals-tab-count').textContent = snapshot.total.toLocaleString('ko-KR');
    $('deals-updated').textContent = `${snapshot.source === 'api' ? '서버 저장 목록' : '저장된 JSON'} · ${snapshot.updatedAt ? `최근 갱신 ${timestamp(snapshot.updatedAt)}` : '갱신 기록 없음'}`;
    const start = snapshot.articles.length ? snapshot.offset + 1 : 0;
    $('articles-summary').textContent = `총 ${snapshot.total.toLocaleString('ko-KR')}개 · ${start}–${snapshot.offset + snapshot.articles.length} 표시 · 최신 ID 순`;
    const fragment = document.createDocumentFragment();
    for (const article of snapshot.articles) {
      const row = document.createElement('tr');
      const titleCell = document.createElement('td');
      const titleLayout = document.createElement('div'); titleLayout.className = 'article-title-layout';
      const category = document.createElement('span'); category.className = 'article-category'; category.textContent = article.category || '미분류'; category.title = category.textContent;
      const title = document.createElement('button'); title.type = 'button'; title.className = 'article-link'; title.textContent = article.title; title.title = `${article.title} · 기본 브라우저에서 원문 열기`;
      title.addEventListener('click', () => {
        void this.#api.openArticle(article.id).catch((error) => { $('articles-error').textContent = error.message; $('articles-error').hidden = false; });
      });
      titleLayout.append(category, title); titleCell.append(titleLayout); row.append(titleCell);
      for (const [value, className, detail] of [
        [article.author || '—', 'article-author', article.author || ''],
        [timestamp(article.createdAt), 'article-date', article.createdAt || ''],
        [number(article.views), 'numeric', ''], [number(article.recommendations), 'numeric', ''], [number(article.commentCount), 'numeric', ''],
      ]) {
        const cell = document.createElement('td'); cell.className = className; cell.textContent = value; cell.title = detail; row.append(cell);
      }
      fragment.append(row);
    }
    $('articles-body').replaceChildren(fragment);
    $('articles-region').scrollTop = 0;
    if (this.#hasData) { $('articles-empty').hidden = true; $('articles-table').hidden = false; }
    else this.#empty('아직 저장된 핫딜 게시글이 없습니다.', '서버를 시작하면 첫 수집 후 여기에 표시됩니다.');
  }
}
