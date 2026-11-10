const PAGE_SIZE = 50;
const COLUMN_KEY = 'hotdeal.articleColumns.v1';
const COLUMNS = [
  ['thumbnailUrl', '썸네일'], ['title', '제목'], ['category', '분류'], ['price', '가격'],
  ['store', '쇼핑몰'], ['shipping', '배송비'], ['author', '작성자'], ['createdAt', '작성일'],
  ['views', '조회'], ['recommendations', '추천'], ['commentCount', '댓글'], ['isNew', '새 글 태그'],
  ['id', '게시글 ID'], ['url', '원문 주소'], ['isNotice', '공지 여부'],
  ['firstSeenAt', '최초 수집'], ['lastSeenAt', '최근 수집'],
];
const DEFAULT_COLUMNS = ['title', 'category', 'price', 'store', 'shipping', 'author', 'createdAt', 'views', 'recommendations', 'commentCount', 'isNew'];
const COUNTS = new Set(['views', 'recommendations', 'commentCount']);
const DATES = new Set(['createdAt', 'firstSeenAt', 'lastSeenAt']);
const columnOrder = (keys) => COLUMNS.filter(([key]) => keys.includes(key));
export function visibleColumns(keys) {
  const requested = columnOrder(Array.isArray(keys) ? keys : []);
  const selected = requested.length ? requested : columnOrder(DEFAULT_COLUMNS);
  // Keep New beside the title when both are selected; it can also be shown on its own.
  return selected.filter(([key]) => key !== 'isNew' || !selected.some(([field]) => field === 'title'));
}
function readColumns() {
  try {
    const value = JSON.parse(localStorage.getItem(COLUMN_KEY));
    const selected = columnOrder(Array.isArray(value) ? value : []);
    if (selected.length) return selected.map(([key]) => key);
  } catch {}
  return DEFAULT_COLUMNS;
}
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
  #snapshot = null;
  #interestOnly = false;
  #category = '';
  #keywords = [];
  #columns = readColumns();
  #shownArticles = [];
  #thumbnailJobs = new WeakMap();
  #observer;

  constructor(api) {
    this.#api = api;
    this.#observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.#observer.unobserve(entry.target);
        void this.#loadThumbnail(entry.target);
      }
    }, { root: $('articles-region'), rootMargin: '120px' });
    this.#initializeColumns();
    const category = $('articles-category');
    this.#category = category.value;
    category.addEventListener('change', () => {
      this.#category = category.value;
      this.#changeFilters();
    });
    $('articles-interest-only').addEventListener('change', () => {
      this.#interestOnly = $('articles-interest-only').checked;
      this.#changeFilters();
    });
    $('refresh-articles').addEventListener('click', () => { void this.#load(); });
    $('articles-prev').addEventListener('click', () => { if (this.#page > 1 && !this.#loading) { this.#page--; void this.#load(); } });
    $('articles-next').addEventListener('click', () => { if (this.#page * PAGE_SIZE < this.#total && !this.#loading) { this.#page++; void this.#load(); } });
  }

  #initializeColumns() {
    const form = $('articles-columns');
    const toggle = $('articles-columns-toggle');
    const status = $('articles-columns-status');
    const checkboxes = new Map();
    for (const [key, name] of COLUMNS) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      checkboxes.set(key, input);
      label.append(input, name);
      $('articles-column-options').append(label);
    }
    const check = (keys) => {
      for (const [key, input] of checkboxes) input.checked = keys.includes(key);
      status.textContent = '한 개 이상의 항목을 선택하세요.';
    };
    const show = (open) => {
      form.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => {
      if (form.hidden) { check(this.#columns); show(true); }
      else show(false);
    });
    form.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      show(false);
      toggle.focus();
    });
    $('articles-columns-all').addEventListener('click', () => check(COLUMNS.map(([key]) => key)));
    $('articles-columns-none').addEventListener('click', () => check([]));
    $('articles-columns-default').addEventListener('click', () => check(DEFAULT_COLUMNS));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const columns = [...checkboxes].filter(([, input]) => input.checked).map(([key]) => key);
      if (!columns.length) { status.textContent = '표시할 항목을 한 개 이상 선택하세요.'; return; }
      this.#columns = columns;
      this.#renderRows();
      try {
        localStorage.setItem(COLUMN_KEY, JSON.stringify(columns));
        show(false);
        toggle.focus();
      } catch {
        status.textContent = '표시 항목을 저장하지 못했습니다. 이번 실행에만 적용됩니다.';
      }
    });
  }

  sync(snapshot) {
    this.#snapshot = snapshot;
    const source = snapshot.phase === 'running' ? snapshot.baseUrl : `file:${snapshot.dataDirectory}`;
    if (source !== this.#source) this.#page = 1;
    this.#source = source;
    this.#context = JSON.stringify([source, snapshot.articleResetRevision, snapshot.status?.lastSuccessAt, snapshot.status?.articleCount,
      this.#category, this.#interestOnly ? this.#keywords : null]);
    if (this.#context !== this.#requestedContext) void this.#load();
  }

  setInterestSettings(settings) {
    const changed = this.#interestOnly && JSON.stringify(settings.keywords) !== JSON.stringify(this.#keywords);
    this.#keywords = [...settings.keywords];
    $('articles-interest-only').disabled = false;
    if (changed) this.#changeFilters();
  }

  #changeFilters() {
    this.#page = 1;
    this.#total = 0;
    this.#hasData = false;
    this.#shownArticles = [];
    $('articles-summary').textContent = '';
    this.#empty('목록을 불러오는 중입니다.', '선택한 조건에 맞는 게시글을 확인하고 있습니다.');
    if (this.#snapshot) this.sync(this.#snapshot);
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
      const snapshot = await this.#api.articles({ limit: PAGE_SIZE, offset: (this.#page - 1) * PAGE_SIZE,
        interestOnly: this.#interestOnly, category: this.#category || null });
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
    $('deals-tab-count').textContent = (snapshot.allTotal ?? snapshot.total).toLocaleString('ko-KR');
    $('deals-updated').textContent = `${snapshot.source === 'api' ? '서버 저장 목록' : '저장된 JSON'} · ${snapshot.updatedAt ? `최근 갱신 ${timestamp(snapshot.updatedAt)}` : '갱신 기록 없음'}`;
    const start = snapshot.articles.length ? snapshot.offset + 1 : 0;
    $('articles-summary').textContent = `${this.#interestOnly ? '관심 품목 ' : '총 '}${snapshot.total.toLocaleString('ko-KR')}개 · ${start}–${snapshot.offset + snapshot.articles.length} 표시 · 최신 ID 순`;
    this.#shownArticles = snapshot.articles;
    this.#renderRows();
    $('articles-region').scrollTop = 0;
    if (this.#hasData) { $('articles-empty').hidden = true; $('articles-table').hidden = false; }
    else if (this.#interestOnly && !this.#keywords.length) this.#empty('등록된 관심 품목이 없습니다.', '관심 품목 탭에서 키워드를 등록하거나 관심 품목만 보기를 해제하세요.');
    else if (this.#category) this.#empty(this.#interestOnly ? '이 분류에 관심 품목과 일치하는 게시글이 없습니다.' : '선택한 분류에 게시글이 없습니다.', '다른 분류를 선택하거나 전체 목록을 보세요.');
    else if (this.#interestOnly) this.#empty('관심 품목과 일치하는 게시글이 없습니다.', '관심 품목 탭에서 키워드를 바꾸거나 관심 품목만 보기를 해제하세요.');
    else this.#empty('아직 저장된 핫딜 게시글이 없습니다.', '서버를 시작하면 첫 수집 후 여기에 표시됩니다.');
  }

  #renderRows() {
    this.#observer.disconnect();
    const columns = visibleColumns(this.#columns);
    const headings = columns.map(([key, name]) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.className = this.#columnClass(key);
      th.textContent = name;
      return th;
    });
    $('articles-head').replaceChildren(...headings);
    const fragment = document.createDocumentFragment();
    for (const article of this.#shownArticles) {
      const row = document.createElement('tr');
      for (const [key] of columns) row.append(this.#cell(article, key));
      fragment.append(row);
    }
    $('articles-body').replaceChildren(fragment);
  }

  #columnClass(key) { return `article-col-${key}${COUNTS.has(key) ? ' numeric' : ''}`; }

  #newBadge() {
    const badge = document.createElement('span');
    badge.className = 'article-new';
    badge.textContent = 'New';
    badge.title = '가장 최근 새 글 수집에서 추가된 게시글';
    return badge;
  }

  #openButton(article, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'article-link';
    button.textContent = label;
    button.title = `${label} · 기본 브라우저에서 원문 열기`;
    button.addEventListener('click', () => {
      void this.#api.openArticle(article.id).catch((error) => {
        $('articles-error').textContent = error.message;
        $('articles-error').hidden = false;
      });
    });
    return button;
  }

  #cell(article, key) {
    const cell = document.createElement('td');
    cell.className = this.#columnClass(key);
    if (key === 'title') {
      const layout = document.createElement('div');
      layout.className = 'article-title-layout';
      const button = this.#openButton(article, article.title);
      if (this.#columns.includes('isNew') && article.isNew === true) {
        const badge = this.#newBadge();
        badge.setAttribute('aria-hidden', 'true');
        button.setAttribute('aria-label', `새 게시글: ${article.title}`);
        layout.append(badge);
      }
      layout.append(button);
      cell.append(layout);
    } else if (key === 'url' && article.url) {
      cell.append(this.#openButton(article, article.url));
    } else if (key === 'category' && article.category) {
      const category = document.createElement('span');
      category.className = 'article-category';
      category.textContent = category.title = article.category;
      cell.append(category);
    } else if (key === 'thumbnailUrl') {
      const preview = document.createElement('div');
      preview.className = 'article-thumb';
      preview.textContent = '—';
      cell.append(preview);
      if (article.thumbnailUrl) {
        this.#thumbnailJobs.set(preview, article);
        this.#observer.observe(preview);
      }
    } else if (key === 'isNew' && article.isNew === true) {
      cell.append(this.#newBadge());
    } else {
      cell.textContent = COUNTS.has(key) ? number(article[key]) : DATES.has(key) ? timestamp(article[key])
        : key === 'isNotice' ? (article.isNotice === true ? '공지' : article.isNotice === false ? '일반' : '—')
        : key === 'isNew' ? '—' : (article[key] || '—');
      if (typeof article[key] === 'string') cell.title = article[key];
    }
    return cell;
  }

  async #loadThumbnail(preview) {
    const article = this.#thumbnailJobs.get(preview);
    if (!article || !preview.isConnected) return;
    try {
      const source = await this.#api.articleThumbnail(article.id, article.thumbnailUrl);
      if (!preview.isConnected || typeof source !== 'string' || !/^data:image\/(?:jpeg|png|gif|webp|avif);base64,/.test(source)) return;
      const img = document.createElement('img');
      img.alt = '';
      img.width = img.height = 100;
      img.addEventListener('error', () => { preview.textContent = '—'; }, { once: true });
      img.src = source;
      preview.replaceChildren(img);
    } catch {}
  }
}
