const api = window.hotdealNotification;
const $ = (id) => document.getElementById(id);
let sequence = 0;
const fail = (error) => { $('error').textContent = error.message; $('error').hidden = false; };
function render(payload) {
  if (!payload || payload.sequence <= sequence) return;
  sequence = payload.sequence;
  $('error').hidden = true;
  $('heading').textContent = payload.test ? '테스트 알림' : `새 핫딜 ${payload.total}개가 도착했습니다`;
  $('summary').textContent = payload.test ? '실제 게시글 수집·저장 없이 미리보기' : '아카라이브 핫딜 · 방금 수집한 새 글';
  $('detail').textContent = payload.total > 3 ? `외 ${payload.total - 3}개 · 마우스를 올리면 유지` : '8초 후 닫힘 · 마우스를 올리면 유지';
  const fragment = document.createDocumentFragment();
  for (const article of payload.articles) {
    const row = document.createElement(payload.test ? 'div' : 'button');
    row.className = 'article';
    if (!payload.test) {
      row.type = 'button';
      row.title = `${article.title} · 기본 브라우저에서 원문 열기`;
      row.addEventListener('click', () => api.openArticle(article.id).catch(fail));
    }
    const meta = document.createElement('span'); meta.className = 'article-meta';
    meta.textContent = [article.category, article.author].filter(Boolean).join(' · ') || '핫딜';
    const title = document.createElement('span'); title.className = 'article-title'; title.textContent = article.title;
    row.append(meta, title); fragment.append(row);
  }
  $('articles').replaceChildren(fragment);
  if (payload.sound) {
    $('chime').volume = 0.35;
    $('chime').currentTime = 0;
    $('chime').play().catch(() => {
      $('summary').textContent += ' · 소리 재생 실패';
    });
  }
}
$('close').addEventListener('click', () => api.close().catch(fail));
$('open-list').addEventListener('click', () => api.openList().catch(fail));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') api.close().catch(fail); });
document.body.addEventListener('mouseenter', () => api.hover(true).catch(fail));
document.body.addEventListener('mouseleave', () => api.hover(false).catch(fail));
api.onUpdate(render);
api.ready().then(render).catch(fail);
