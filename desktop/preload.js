const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  choose: (opts) => ipcRenderer.invoke('setup:choose', opts),
  current: () => ipcRenderer.invoke('setup:current'),
});
