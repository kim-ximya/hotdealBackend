const $ = (id) => document.getElementById(id);
let current = { revision: -1, logs: [] };

function render() {
  const list = $('log-list');
  const top = list.scrollTop;
  const filter = $('log-filter').value;
  const lines = current.logs.filter((log) => filter === 'all' || filter === log.level);
  const fragment = document.createDocumentFragment();
  for (const log of lines) {
    const row = document.createElement('div');
    row.className = `log-line ${['error', 'browser'].includes(log.level) ? log.level : 'info'}`;
    for (const [className, value] of [['log-time', new Date(log.at).toLocaleTimeString('en-GB', { hour12: false })],
      ['log-level', log.level === 'error' ? 'ERROR' : log.level === 'browser' ? 'CHROME' : 'INFO'], ['log-message', log.message]]) {
      const span = document.createElement('span'); span.className = className; span.textContent = value; row.append(span);
    }
    fragment.append(row);
  }
  if (!lines.length) { const empty = document.createElement('p'); empty.className = 'empty-log'; empty.textContent = '표시할 로그가 없습니다.'; fragment.append(empty); }
  list.replaceChildren(fragment);
  $('log-count').textContent = current.logs.length;
  $('logs-summary').textContent = `${lines.length}개 표시 · 현재 앱 세션 · 최근 500개`;
  list.scrollTop = $('auto-scroll').checked ? list.scrollHeight : top;
}

function accept(snapshot) {
  if (snapshot.revision <= current.revision) return;
  current = snapshot;
  render();
}
function showError(error) { $('logs-error').textContent = error.message; $('logs-error').hidden = false; }

const unsubscribe = window.hotdealLogs.onUpdate(accept);
window.addEventListener('unload', unsubscribe, { once: true });
window.hotdealLogs.read().then(accept).catch(showError);
$('log-filter').addEventListener('change', render);
$('auto-scroll').addEventListener('change', () => { if ($('auto-scroll').checked) $('log-list').scrollTop = $('log-list').scrollHeight; });
$('clear-logs').addEventListener('click', async () => {
  $('clear-logs').disabled = true;
  $('logs-error').hidden = true;
  try { accept(await window.hotdealLogs.clear()); }
  catch (error) { showError(error); }
  finally { $('clear-logs').disabled = false; }
});
