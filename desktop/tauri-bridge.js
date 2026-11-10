const tauri = window.__TAURI__;
const call = async (name, args = {}) => {
  try { return await tauri.core.invoke(name, args); }
  catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
};
const subscribe = (name, callback) => {
  const registration = tauri.event.listen(name, ({ payload }) => callback(payload));
  registration.catch((error) => console.error('이벤트 연결 실패', error));
  return () => { void registration.then((unlisten) => unlisten()).catch(() => {}); };
};
const action = (name, value) => call('desktop_action', { name, value });
const notification = (name, value) => call('notification_action', { name, value });
let pendingSettings = Promise.resolve();
const settingsAction = (name, value) => {
  const result = pendingSettings.then(() => action(name, value));
  pendingSettings = result.catch(() => {});
  return result;
};

export const mainApi = {
  snapshot: () => action('snapshot'), start: () => action('start'), stop: () => action('stop'),
  collect: () => action('collect'), setInterval: (value) => action('interval', value),
  setUserAgent: (value) => action('userAgent', value), articles: (value) => action('articles', value),
  articleThumbnail: (id, source) => action('articleThumbnail', { id, source }),
  resetArticles: () => action('resetArticles'),
  resetSettings: () => settingsAction('resetSettings'),
  openArticle: (id) => action('openArticle', id), openLogs: () => action('openLogs'),
  openData: () => action('openData'), hideToTray: () => action('hideToTray'),
  updateState: () => action('updateState'), downloadUpdate: () => action('downloadUpdate'),
  installUpdate: () => action('installUpdate'), onUpdate: (fn) => subscribe('hotdeal:update', fn),
  notificationSettings: () => settingsAction('notificationSettings'),
  setNotificationSettings: (value) => settingsAction('setNotificationSettings', value),
  testNotification: () => action('testNotification'),
  interestSettings: () => settingsAction('interestSettings'),
  setInterestSettings: (value) => settingsAction('setInterestSettings', value),
  startupSettings: () => settingsAction('startupSettings'), setStartupSettings: (value) => settingsAction('setStartupSettings', value),
  onShowArticles: (fn) => subscribe('hotdeal:showArticles', fn),
  onSnapshot: (fn) => subscribe('hotdeal:snapshot', fn),
};
export const logsApi = {
  read: () => call('logs_action', { clear: false }), clear: () => call('logs_action', { clear: true }),
  onUpdate: (fn) => subscribe('hotdeal:logs', fn),
};
export const notificationApi = {
  ready: () => notification('ready'), close: () => notification('close'),
  beginDrag: (x) => notification('drag-start', x), moveDrag: (x) => notification('drag-move', x),
  endDrag: (x) => notification('drag-end', x), cancelDrag: () => notification('drag-cancel'),
  hover: (hovered) => notification('hover', hovered), openList: () => notification('list'),
  openArticle: (id) => notification('article', id),
  onUpdate: (fn) => subscribe('hotdeal:notification', fn),
  onDismiss: (fn) => subscribe('hotdeal:notification-dismiss', fn),
};
