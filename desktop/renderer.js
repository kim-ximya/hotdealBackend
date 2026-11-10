import { mainApi } from './tauri-bridge.js';
import { ArticleListView } from './article-list.js';
import { InterestView } from './interest-view.js';
import { UpdateView } from './update-view.js';

const $ = (id) => document.getElementById(id);
const resetDialog = $('reset-dialog');
const resetConfirm = $('confirm-reset');
const resetCancel = $('cancel-reset');
const resetWait = $('reset-wait');
const articleList = new ArticleListView(mainApi);
const updateView = new UpdateView(mainApi, { version: $('app-version'), button: $('app-update'), status: $('update-status') });
void updateView.initialize();
let current;
let busy = false;
let dirty = false;
let userAgentDirty = false;
let toastTimer;
let resetTimer;
let resetAvailableAt = 0;
let pendingReset;
let resetting = false;
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
function canReset(snapshot) {
  return snapshot && !busy && !snapshot.owned && ['stopped', 'error'].includes(snapshot.phase);
}
function updateResetConfirmation() {
  const seconds = Math.max(0, Math.ceil((resetAvailableAt - performance.now()) / 1000));
  resetConfirm.disabled = resetting || seconds > 0 || !canReset(current);
  const message = resetting ? '초기화하는 중입니다.'
    : seconds > 0 ? `${seconds}초 후에 초기화 버튼이 활성화됩니다.`
    : canReset(current) ? '초기화하려면 아래 버튼을 누르세요.' : '수집 서버를 중지한 뒤 다시 시도하세요.';
  if (resetWait.textContent !== message) resetWait.textContent = message;
  if (seconds === 0) clearInterval(resetTimer);
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
  $('next-run').title = $('next-detail').textContent;
}
function render(snapshot) {
  if (current && snapshot.revision < current.revision) return;
  current = snapshot;
  const { phase, owned, status } = snapshot;
  const running = phase === 'running';
  const transitioning = phase === 'starting' || phase === 'stopping';
  $('phase-label').textContent = { stopped: '서버 중지', starting: '시작 중', stopping: '종료 중', running: owned ? '서버 실행 중' : '외부 서버 연결', error: '오류 확인 필요' }[phase];
  $('status-dot').className = `dot ${phase}`;
  $('headline').textContent = { stopped: '수집을 시작할 준비가 되었습니다.', starting: '백그라운드 수집 서버를 시작합니다.', stopping: '수집 서버를 안전하게 종료합니다.', running: status?.isCollecting ? '핫딜 게시글을 수집하고 있습니다.' : '다음 핫딜 수집을 기다리고 있습니다.', error: '서버 상태를 확인해 주세요.' }[phase];
  $('subline').textContent = running ? `${intervalText(snapshot.intervalSeconds)}마다 자동 수집 · ${owned ? 'Chrome 헤드리스' : '별도로 실행 중인 서버'}` : phase === 'stopping' ? '진행 중인 작업과 백그라운드 Chrome을 종료합니다.' : 'Chrome 창 없이 수집하고 저장된 JSON을 로컬 API로 제공합니다.';
  $('headline').title = $('headline').textContent;
  $('subline').title = $('subline').textContent;
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
  $('reset-articles').disabled = $('reset-settings').disabled = !canReset(snapshot);
  if (resetDialog.open) updateResetConfirmation();
  $('article-count').textContent = (status?.articleCount || 0).toLocaleString('ko-KR');
  $('last-success').textContent = time(status?.lastSuccessAt);
  $('last-date').textContent = date(status?.lastSuccessAt);
  $('last-success').title = status?.lastSuccessAt ? `${date(status.lastSuccessAt)} ${time(status.lastSuccessAt)}` : '첫 수집을 기다리고 있습니다.';
  $('browser-stage').textContent = stages[status?.browser?.stage] || '대기 중';
  $('run-count').textContent = `이번 실행 성공 ${status?.successes || 0}회 / 시도 ${status?.attempts || 0}회`;
  $('browser-stage').title = `${$('browser-stage').textContent} · ${$('run-count').textContent}`;
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
  renderCountdown();
  articleList.sync(snapshot);
}
$('start').addEventListener('click', () => action(() => mainApi.start(), '서버를 시작했습니다.'));
$('stop').addEventListener('click', () => action(() => mainApi.stop(), current?.owned ? '서버를 중지했습니다.' : '연결을 해제했습니다.'));
$('collect').addEventListener('click', () => action(() => mainApi.collect(), '즉시 수집을 요청했습니다.'));
function showReset({ title, description, label, operation, success }) {
  if (!canReset(current) || resetDialog.open) return;
  pendingReset = { operation, success };
  $('reset-title').textContent = title;
  $('reset-description').textContent = description;
  resetConfirm.textContent = label;
  resetConfirm.disabled = true;
  resetDialog.showModal();
  resetAvailableAt = performance.now() + 5000;
  clearInterval(resetTimer);
  resetTimer = setInterval(updateResetConfirmation, 100);
  updateResetConfirmation();
}
$('reset-articles').addEventListener('click', () => {
  const count = current?.localArticleCount;
  const stored = count > 0 ? ` 앱이 확인한 보관 글은 ${count.toLocaleString('ko-KR')}개입니다.` : '';
  showReset({
    title: '게시글 데이터를 초기화할까요?',
    description: `저장된 게시글과 썸네일이 모두 삭제됩니다.${stored} 이 작업은 되돌릴 수 없습니다.`,
    label: '게시글 데이터 초기화',
    operation: () => mainApi.resetArticles(),
    success: '저장된 게시글과 썸네일을 초기화했습니다.',
  });
});
$('reset-settings').addEventListener('click', () => {
  showReset({
    title: '수집기 설정을 초기화할까요?',
    description: '수집 간격, User-Agent, 알림, Windows 자동 실행과 목록 표시 설정을 기본값으로 되돌립니다. 등록한 관심 품목도 삭제됩니다.',
    label: '수집기 설정 초기화',
    operation: resetSettings,
    success: '수집기 설정을 기본값으로 되돌렸습니다.',
  });
});
resetDialog.addEventListener('close', () => {
  if (resetDialog.open) return;
  clearInterval(resetTimer);
  resetConfirm.disabled = true;
  pendingReset = null;
});
resetDialog.addEventListener('cancel', (event) => { if (resetting) event.preventDefault(); });
resetConfirm.addEventListener('click', async () => {
  if (!resetDialog.open || resetConfirm.disabled || performance.now() < resetAvailableAt || !canReset(current)) return;
  resetting = true;
  resetCancel.disabled = true;
  try { await action(pendingReset.operation, pendingReset.success); }
  finally {
    resetting = false;
    resetCancel.disabled = false;
    resetDialog.close();
  }
});
// Hiding the window remains available while a server action is in progress.
$('hide-to-tray').addEventListener('click', () => {
  mainApi.hideToTray().catch((error) => {
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
  void action(async () => { const snapshot = await mainApi.setInterval(seconds); dirty = false; return snapshot; }, '수집 간격을 저장했습니다.');
});
$('user-agent').addEventListener('input', () => { userAgentDirty = true; });
$('user-agent-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    const snapshot = await mainApi.setUserAgent($('user-agent').value);
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
bindTabs([['deals-tab', 'deals-view'], ['interests-tab', 'interests-view'], ['settings-tab', 'settings-view']]);
const interestView = new InterestView(mainApi, { onChange: (settings) => articleList.setInterestSettings(settings), toast });
bindTabs([...document.querySelectorAll('.settings-tabs [role="tab"]')].map((tab) => [tab.id, tab.getAttribute('aria-controls')]));
async function resetSettings() {
  const { snapshot, interests, notifications, startup, errors } = await mainApi.resetSettings();
  dirty = false;
  userAgentDirty = false;
  try { articleList.resetPreferences(); }
  catch { errors.push('목록 표시 항목을 저장소에서 지우지 못했습니다.'); }
  interestView.resetSettings(interests);
  renderNotificationSettings(notifications);
  if (startup) renderStartupSettings(startup);
  if (errors.length) {
    render(snapshot);
    throw new Error(`일부 설정을 초기화하지 못했습니다. ${errors.join(' ')}`);
  }
  return snapshot;
}
function renderStartupSettings(settings) {
  $('startup-enabled').checked = settings.enabled;
  $('startup-enabled').disabled = !settings.supported;
  $('save-startup').disabled = !settings.supported;
  $('startup-status').textContent = !settings.supported ? 'Windows에서만 사용할 수 있습니다.'
    : settings.disabledByWindows ? '등록됨 · Windows 시작 앱에서 사용 안 함으로 설정됨'
    : settings.enabled ? '자동 실행 켜짐 · 로그인 시 트레이와 수집 서버 시작' : '자동 실행 꺼짐';
}
async function refreshStartupSettings() {
  $('refresh-startup').disabled = true;
  try { renderStartupSettings(await mainApi.startupSettings()); }
  catch (error) { $('startup-status').textContent = error.message; }
  finally { $('refresh-startup').disabled = false; }
}
void refreshStartupSettings();
$('refresh-startup').addEventListener('click', refreshStartupSettings);
$('startup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('startup-enabled').disabled = true;
  $('save-startup').disabled = true;
  try {
    renderStartupSettings(await mainApi.setStartupSettings($('startup-enabled').checked));
    toast('Windows 자동 실행 설정을 적용했습니다.');
  } catch (error) {
    $('startup-status').textContent = error.message;
    $('startup-enabled').disabled = false;
    $('save-startup').disabled = false;
  }
});
function renderNotificationSettings(settings) {
  $('notifications-enabled').checked = settings.enabled;
  $('notification-sound').checked = settings.soundEnabled;
  $('notification-status').textContent = `새 글 알림 ${settings.enabled ? '켜짐' : '꺼짐'} · 소리 ${settings.soundEnabled ? '켜짐' : '꺼짐'}`;
  for (const id of ['notifications-enabled', 'notification-sound', 'save-notifications']) $(id).disabled = false;
}
mainApi.notificationSettings().then(renderNotificationSettings).catch((error) => {
  $('notification-status').textContent = `설정을 불러오지 못했습니다: ${error.message}`;
});
$('notification-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('save-notifications').disabled = true;
  try {
    renderNotificationSettings(await mainApi.setNotificationSettings({
      enabled: $('notifications-enabled').checked, soundEnabled: $('notification-sound').checked,
    }));
    toast('알림 설정을 저장했습니다. 바로 적용됩니다.');
  } catch (error) { $('notification-status').textContent = error.message; }
  finally { $('save-notifications').disabled = false; }
});
$('test-notification').addEventListener('click', async () => {
  $('test-notification').disabled = true;
  try { await mainApi.testNotification(); }
  catch (error) { $('notification-status').textContent = error.message; }
  finally { $('test-notification').disabled = false; }
});
mainApi.onShowArticles(() => $('deals-tab').click());
$('open-data').addEventListener('click', () => action(() => mainApi.openData()));
$('open-logs').addEventListener('click', async () => {
  $('open-logs').disabled = true;
  try { await mainApi.openLogs(); }
  catch (error) { actionError = error.message; if (current) render(current); }
  finally { $('open-logs').disabled = false; }
});
mainApi.onSnapshot(render);
mainApi.snapshot().then(render).catch((error) => { $('error').textContent = error.message; $('error').hidden = false; });
setInterval(renderCountdown, 1000);
