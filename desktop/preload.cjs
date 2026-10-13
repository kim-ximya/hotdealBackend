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
  clearLogs: () => invoke('clearLogs'), openData: () => invoke('openData'),
  hideToTray: () => invoke('hideToTray'),
  notificationSettings: () => invoke('notificationSettings'),
  setNotificationSettings: (value) => invoke('setNotificationSettings', value),
  testNotification: () => invoke('testNotification'),
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
