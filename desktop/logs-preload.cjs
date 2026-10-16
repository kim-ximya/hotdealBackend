const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (action) => {
  const result = await ipcRenderer.invoke(`hotdeal-logs:${action}`);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('hotdealLogs', {
  read: () => invoke('read'),
  clear: () => invoke('clear'),
  onUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('hotdeal-logs:update', listener);
    return () => ipcRenderer.removeListener('hotdeal-logs:update', listener);
  },
});
