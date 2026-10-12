import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAX_HTML_BYTES, parseArticleList } from '../src/article-parser.js';

const html = await readFile(new URL('./fixtures/hotdeal-list.html', import.meta.url), 'utf8');
const hybridHtml = await readFile(new URL('./fixtures/hotdeal-hybrid.html', import.meta.url), 'utf8');

test('hotdeal category links before a hybrid title do not hide regular deals behind notices', () => {
  const articles = parseArticleList(hybridHtml);
  assert.equal(articles.length, 3);
  const deals = articles.filter((article) => !article.isNotice);
  assert.deepEqual(deals, [{
    id: '185704738', url: 'https://arca.live/b/hotdeal/185704738',
    title: '하우스 플리퍼 2', category: 'SW/게임', author: '세리키누스_몬텔라',
    createdAt: '2026-10-12T08:24:14.000Z', views: 23, recommendations: 0,
    commentCount: null, isNotice: false,
  }]);
});

test('reads div titles and removes hybrid metadata from the title column fallback', () => {
  const articles = parseArticleList(`<div class="article-list"><div class="list-table">
    <a class="vrow hybrid" href="/b/hotdeal/1"><div class="title">일반 제목<span class="info">부가 정보</span></div></a>
    <div class="vrow hybrid"><span class="col-title"><span class="badges"><span class="deal-store">스팀</span><a class="badge" href="/b/hotdeal?category=sw">게임</a></span><a href="/b/hotdeal/2">다른 제목</a></span></div>
  </div></div>`);
  assert.deepEqual(articles.map((article) => article.title), ['일반 제목', '다른 제목']);
});

test('does not accept notices as a successful snapshot when a regular post title is missing', () => {
  const broken = hybridHtml.replace('title hybrid-title', 'changed-title').replace('vcol col-title', 'changed-column');
  assert.throws(() => parseArticleList(broken), /일반 게시글 1개의 제목을 추출/);
});

test('extracts desktop and hybrid rows, decodes entities, removes metadata and canonicalizes links', () => {
  const articles = parseArticleList(html);
  assert.deepEqual(articles.map((article) => article.id), ['100', '300', '299', '298']);
  assert.deepEqual(articles[1], {
    id: '300', url: 'https://arca.live/b/hotdeal/300',
    title: '[쇼핑몰] SSD & USB 특가', category: '전자제품', author: '판매정보',
    createdAt: '2026-10-12T08:10:00Z', views: 1234, recommendations: 5, commentCount: 12, isNotice: false,
  });
  assert.equal(articles[0].isNotice, true);
  assert.equal(articles[2].title, '커피 <한정>');
  assert.equal(articles[2].views, 1200);
  assert.equal(articles[2].commentCount, 3);
  assert.equal(articles[3].title, '제목만 있는 글');
  assert.equal(articles[3].createdAt, null);
  assert.equal(articles[3].views, null);
  assert.equal(articles[3].author, null);
});

test('challenge/login/malformed HTML is rejected instead of treated as an empty successful list', () => {
  for (const input of ['', '<h1>Just a moment...</h1>', '<form>로그인</form>', '<div class="list-table"></div>']) {
    assert.throws(() => parseArticleList(input), /목록/);
  }
  assert.throws(() => parseArticleList('<div class="article-list"><div class="list-table"><a class="vrow" href="/b/hotdeal/1">구조 변경</a></div></div>'), /추출/);
  assert.deepEqual(parseArticleList('<div class="article-list"><div class="list-table"></div></div>'), []);
});

test('limits HTML by UTF-8 byte length', () => {
  assert.throws(() => parseArticleList('한'.repeat(Math.ceil(MAX_HTML_BYTES / 3))), /1 MiB/);
});

test('excludes staff authors beginning with * while retaining ordinary and unknown authors', () => {
  const articles = parseArticleList(`<div class="article-list"><div class="list-table">
    <a class="vrow notice" href="/b/hotdeal/1"><span class="title">운영 공지</span><span class="col-author">*ㅎㅎ</span></a>
    <a class="vrow hybrid" href="/b/hotdeal/2"><span class="title">운영진 글</span><span class="col-author"> &nbsp; *운영진 </span></a>
    <a class="vrow hybrid" href="/b/hotdeal/3"><span class="title">일반 핫딜</span><span class="col-author">일반*작성자</span></a>
    <a class="vrow hybrid" href="/b/hotdeal/4"><span class="title">작성자 정보 없는 글</span></a>
  </div></div>`);
  assert.deepEqual(articles.map(({ id, author }) => ({ id, author })), [
    { id: '3', author: '일반*작성자' }, { id: '4', author: null },
  ]);
  assert.deepEqual(parseArticleList(`<div class="article-list"><div class="list-table">
    <a class="vrow notice" href="/b/hotdeal/1"><span class="title">공지뿐인 목록</span><span class="col-author">*ㅎㅎ</span></a>
  </div></div>`), []);
});
