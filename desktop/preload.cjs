const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (action, value) => {
  const result = await ipcRenderer.invoke(`hotdeal:${action}`, value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('hotdeal', {
  snapshot: () => invoke('snapshot'), start: () => invoke('start'), stop: () => invoke('stop'),
  setInterval: (value) => invoke('interval', value), collect: () => invoke('collect'),
  setUserAgent: (value) => invoke('userAgent', value),
  articles: (query) => invoke('articles', query), openArticle: (id) => invoke('openArticle', id),
  openLogs: () => invoke('openLogs'), openData: () => invoke('openData'),
  hideToTray: () => invoke('hideToTray'),
  updateState: () => invoke('updateState'),
  downloadUpdate: () => invoke('downloadUpdate'),
  installUpdate: () => invoke('installUpdate'),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('hotdeal:update', listener);
    return () => ipcRenderer.removeListener('hotdeal:update', listener);
  },
  notificationSettings: () => invoke('notificationSettings'),
  setNotificationSettings: (value) => invoke('setNotificationSettings', value),
  testNotification: () => invoke('testNotification'),
  interestSettings: () => invoke('interestSettings'),
  setInterestSettings: (value) => invoke('setInterestSettings', value),
  startupSettings: () => invoke('startupSettings'),
  setStartupSettings: (enabled) => invoke('setStartupSettings', enabled),
  onShowArticles: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('hotdeal:showArticles', listener);
    return () => ipcRenderer.removeListener('hotdeal:showArticles', listener);
  },
  onSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('hotdeal:snapshot', listener);
    return () => ipcRenderer.removeListener('hotdeal:snapshot', listener);
  },
});
