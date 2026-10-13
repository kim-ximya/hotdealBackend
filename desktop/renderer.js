import { ArticleListView } from './article-list.js';

const $ = (id) => document.getElementById(id);
const articleList = new ArticleListView(window.hotdeal);
let current;
let busy = false;
let dirty = false;
let userAgentDirty = false;
let toastTimer;
let logSignature;
let actionError = null;
const time = (value) => value ? new Date(value).toLocaleTimeString('en-GB', { hour12: false }) : '기록 없음';
const date = (value) => value ? new Date(value).toLocaleDateString('ko-KR') : '첫 수집을 기다리고 있습니다.';
const intervalText = (seconds) => seconds % 60 === 0 ? `${seconds / 60}분` : `${seconds}초`;
const stages = { idle: '대기 중', 'starting-browser': '백그라운드 시작', navigating: '페이지 접속 중', 'waiting-for-list': '목록 대기 중', parsing: '목록 분석 중', error: '오류 확인 필요', closed: '중지됨' };

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}
async function action(operation, message) {
  if (busy) return;
  busy = true;
  actionError = null;
  if (current) render(current);
  try {
    const snapshot = await operation();
    if (snapshot) render(snapshot);
    if (message) toast(message);
  } catch (error) { actionError = error.message; }
  finally { busy = false; if (current) render(current); }
}
function renderLogs(snapshot) {
  const filter = $('log-filter').value;
  const signature = `${filter}/${snapshot.logs[0]?.id}/${snapshot.logs.at(-1)?.id}/${snapshot.logs.length}`;
  if (signature === logSignature) return;
  logSignature = signature;
  const list = $('log-list');
  const top = list.scrollTop;
  const lines = snapshot.logs.filter((log) => filter === 'all' || filter === log.level);
  const fragment = document.createDocumentFragment();
  for (const log of lines) {
    const row = document.createElement('div');
    row.className = `log-line ${['error', 'browser'].includes(log.level) ? log.level : 'info'}`;
    for (const [className, value] of [['log-time', time(log.at)], ['log-level', log.level === 'error' ? 'ERROR' : log.level === 'browser' ? 'CHROME' : 'INFO'], ['log-message', log.message]]) {
      const span = document.createElement('span'); span.className = className; span.textContent = value; row.append(span);
    }
    fragment.append(row);
  }
  if (!lines.length) { const empty = document.createElement('div'); empty.className = 'empty-log'; empty.textContent = '표시할 로그가 없습니다.'; fragment.append(empty); }
  list.replaceChildren(fragment);
  $('log-count').textContent = snapshot.logs.length;
  list.scrollTop = $('auto-scroll').checked ? list.scrollHeight : top;
}
function renderCountdown() {
  const status = current?.status;
  if (status?.isCollecting && current.phase === 'running') {
    $('next-run').textContent = '수집 중'; $('next-detail').textContent = '완료 후 다음 수집이 예약됩니다.';
  } else if (status?.nextRunAt && current.phase === 'running') {
    const seconds = Math.max(0, Math.ceil((Date.parse(status.nextRunAt) - Date.now()) / 1000));
    $('next-run').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    $('next-detail').textContent = `${time(status.nextRunAt)} 수집 예정`;
  } else { $('next-run').textContent = '—'; $('next-detail').textContent = '서버를 시작하면 예약됩니다.'; }
}
function render(snapshot) {
  current = snapshot;
  const { phase, owned, status } = snapshot;
  const running = phase === 'running';
  const transitioning = phase === 'starting' || phase === 'stopping';
  $('phase-label').textContent = { stopped: '서버 중지', starting: '시작 중', stopping: '종료 중', running: owned ? '서버 실행 중' : '외부 서버 연결', error: '오류 확인 필요' }[phase];
  $('status-dot').className = `dot ${phase}`;
  $('headline').textContent = { stopped: '수집을 시작할 준비가 되었습니다.', starting: '백그라운드 수집 서버를 시작합니다.', stopping: '수집 서버를 안전하게 종료합니다.', running: status?.isCollecting ? '핫딜 게시글을 수집하고 있습니다.' : '다음 핫딜 수집을 기다리고 있습니다.', error: '서버 상태를 확인해 주세요.' }[phase];
  $('subline').textContent = running ? `${intervalText(snapshot.intervalSeconds)}마다 자동 수집 · ${owned ? 'Chrome 헤드리스' : '별도로 실행 중인 서버'}` : phase === 'stopping' ? '진행 중인 작업과 백그라운드 Chrome을 종료합니다.' : 'Chrome 창 없이 수집하고 저장된 JSON을 로컬 API로 제공합니다.';
  $('start').disabled = busy || running || transitioning || (phase === 'error' && owned);
  $('stop').disabled = busy || (phase === 'stopped') || transitioning;
  $('stop').textContent = !owned && running ? '연결 해제' : '서버 중지';
  $('collect').disabled = busy || !running || status?.isCollecting;
  $('apply').disabled = busy || transitioning;
  const external = running && !owned;
  $('browser-mode').textContent = external && status?.browser?.headless !== true
    ? '외부 서버 연결 · 브라우저 모드 확인 필요' : 'Chrome 헤드리스 · 백그라운드 수집';
  $('save-user-agent').disabled = busy || transitioning || external;
  $('user-agent').disabled = transitioning || external;
  if (!userAgentDirty) $('user-agent').value = snapshot.userAgent || '';
  const activeUserAgent = status?.browser?.userAgent;
  const needsRestart = running && owned && typeof activeUserAgent === 'string' && snapshot.userAgent !== activeUserAgent;
  $('user-agent-status').textContent = external ? '외부 서버 연결 중에는 변경할 수 없습니다.'
    : needsRestart ? '설정 저장됨 · 재시작 필요'
    : snapshot.userAgent ? '사용자 지정 User-Agent 저장됨' : 'Chrome 기본값 사용';
  $('user-agent-restart').hidden = !needsRestart;
  $('open-data').disabled = busy || (running && !owned);
  $('article-count').textContent = (status?.articleCount || 0).toLocaleString('ko-KR');
  $('last-success').textContent = time(status?.lastSuccessAt);
  $('last-date').textContent = date(status?.lastSuccessAt);
  $('browser-stage').textContent = stages[status?.browser?.stage] || '대기 중';
  $('run-count').textContent = `이번 실행 성공 ${status?.successes || 0}회 / 시도 ${status?.attempts || 0}회`;
  $('saved-interval').textContent = intervalText(snapshot.intervalSeconds);
  $('saved-note').textContent = !owned && running ? '외부 서버의 설정에 저장합니다.' : '재시작 후에도 유지됩니다.';
  if (!dirty) {
    const inMinutes = snapshot.intervalSeconds % 60 === 0;
    $('unit').value = inMinutes ? '60' : '1';
    $('interval').value = snapshot.intervalSeconds / Number($('unit').value);
    $('interval').max = inMinutes ? '1440' : '86400';
  }
  $('data-path').textContent = !owned && running ? '외부 서버의 데이터 폴더를 사용합니다.' : snapshot.dataDirectory;
  $('data-path').title = $('data-path').textContent;
  $('api-url').textContent = running ? snapshot.baseUrl : '서버 시작 후 표시됩니다.';
  const error = actionError || snapshot.error || status?.lastError?.message;
  $('error').hidden = !error;
  $('error').textContent = error || '';
  $('attention').hidden = !running || !status?.browser?.attentionRequired;
  $('footer-state').textContent = running ? 'JSON 저장 · 로컬 API 제공 중' : '로컬에서 안전하게 보관';
  renderCountdown(); renderLogs(snapshot);
  articleList.sync(snapshot);
}
$('start').addEventListener('click', () => action(() => window.hotdeal.start(), '서버를 시작했습니다.'));
$('stop').addEventListener('click', () => action(() => window.hotdeal.stop(), current?.owned ? '서버를 중지했습니다.' : '연결을 해제했습니다.'));
$('collect').addEventListener('click', () => action(() => window.hotdeal.collect(), '즉시 수집을 요청했습니다.'));
// Hiding the window remains available while a server action is in progress.
$('hide-to-tray').addEventListener('click', () => {
  window.hotdeal.hideToTray().catch((error) => {
    actionError = error.message;
    if (current) render(current);
    else { $('error').textContent = actionError; $('error').hidden = false; }
  });
});
$('interval').addEventListener('input', () => { dirty = true; });
$('unit').addEventListener('change', () => { dirty = true; $('interval').max = Number($('unit').value) === 60 ? '1440' : '86400'; });
$('interval-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const seconds = Number($('interval').value) * Number($('unit').value);
  void action(async () => { const snapshot = await window.hotdeal.setInterval(seconds); dirty = false; return snapshot; }, '수집 간격을 저장했습니다.');
});
$('user-agent').addEventListener('input', () => { userAgentDirty = true; });
$('user-agent-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    const snapshot = await window.hotdeal.setUserAgent($('user-agent').value);
    userAgentDirty = false;
    return snapshot;
  }, 'User-Agent를 저장했습니다. 다음 서버 시작부터 적용됩니다.');
});
function bindTabs(tabs) {
  for (const [id] of tabs) {
    $(id).addEventListener('click', () => {
      for (const [tab, panel] of tabs) {
        const selected = tab === id;
        $(tab).setAttribute('aria-selected', String(selected));
        $(tab).tabIndex = selected ? 0 : -1;
        $(panel).hidden = !selected;
      }
    });
    $(id).addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.findIndex(([tab]) => tab === id);
      const next = event.key === 'Home' ? tabs[0][0] : event.key === 'End' ? tabs.at(-1)[0]
        : tabs[(index + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length][0];
      $(next).click(); $(next).focus();
    });
  }
}
bindTabs([['deals-tab', 'deals-view'], ['settings-tab', 'settings-view']]);
bindTabs([['collection-tab', 'collection-settings'], ['browser-tab', 'browser-settings'], ['notification-tab', 'notification-settings']]);
function renderNotificationSettings(settings) {
  $('notifications-enabled').checked = settings.enabled;
  $('notification-sound').checked = settings.soundEnabled;
  $('notification-status').textContent = `새 글 알림 ${settings.enabled ? '켜짐' : '꺼짐'} · 소리 ${settings.soundEnabled ? '켜짐' : '꺼짐'}`;
  for (const id of ['notifications-enabled', 'notification-sound', 'save-notifications']) $(id).disabled = false;
}
window.hotdeal.notificationSettings().then(renderNotificationSettings).catch((error) => {
  $('notification-status').textContent = `설정을 불러오지 못했습니다: ${error.message}`;
});
$('notification-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('save-notifications').disabled = true;
  try {
    renderNotificationSettings(await window.hotdeal.setNotificationSettings({
      enabled: $('notifications-enabled').checked, soundEnabled: $('notification-sound').checked,
    }));
    toast('알림 설정을 저장했습니다. 바로 적용됩니다.');
  } catch (error) { $('notification-status').textContent = error.message; }
  finally { $('save-notifications').disabled = false; }
});
$('test-notification').addEventListener('click', async () => {
  $('test-notification').disabled = true;
  try { await window.hotdeal.testNotification(); }
  catch (error) { $('notification-status').textContent = error.message; }
  finally { $('test-notification').disabled = false; }
});
window.hotdeal.onShowArticles(() => $('deals-tab').click());
$('open-data').addEventListener('click', () => action(() => window.hotdeal.openData()));
$('clear-logs').addEventListener('click', () => action(() => window.hotdeal.clearLogs()));
$('log-filter').addEventListener('change', () => { if (current) renderLogs(current); });
window.hotdeal.onSnapshot(render);
window.hotdeal.snapshot().then(render).catch((error) => { $('error').textContent = error.message; $('error').hidden = false; });
setInterval(renderCountdown, 1000);
