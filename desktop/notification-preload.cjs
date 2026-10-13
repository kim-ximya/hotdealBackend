const { contextBridge, ipcRenderer } = require('electron');
const action = async (name, value) => {
  const result = await ipcRenderer.invoke('hotdeal-notification:action', name, value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('hotdealNotification', {
  ready: () => action('ready'), close: () => action('close'),
  beginDrag: (screenX) => action('drag-start', screenX), moveDrag: (screenX) => action('drag-move', screenX),
  endDrag: (screenX) => action('drag-end', screenX), cancelDrag: () => action('drag-cancel'),
  hover: (value) => action('hover', value), openList: () => action('list'), openArticle: (id) => action('article', id),
  onUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('hotdeal-notification:update', listener);
    return () => ipcRenderer.removeListener('hotdeal-notification:update', listener);
  },
});
