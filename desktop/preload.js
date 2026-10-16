const { contextBridge, ipcRenderer } = require('electron');

// Tela de escolha de servidor (setup.html).
contextBridge.exposeInMainWorld('setup', {
  choose: (opts) => ipcRenderer.invoke('setup:choose', opts),
  current: () => ipcRenderer.invoke('setup:current'),
});

// Recursos do app de desktop para a interface do site.
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  getInfo: () => ipcRenderer.invoke('app:info'),
  startTunnel: () => ipcRenderer.invoke('tunnel:start'),
  stopTunnel: () => ipcRenderer.invoke('tunnel:stop'),
  leaveServer: () => ipcRenderer.invoke('app:leave-server'),
  getTurn: () => ipcRenderer.invoke('turn:get'),
  setTurn: (turn) => ipcRenderer.invoke('turn:set', turn),
  setGlobalShortcuts: (opts) => ipcRenderer.invoke('shortcuts:set', opts),
  onShortcut: (cb) => ipcRenderer.on('shortcut:action', (_e, id) => cb(id)),
  onPickSources: (cb) => ipcRenderer.on('picker:sources', (_e, payload) => cb(payload)),
  pickSource: (reqId, sourceId, audio) => ipcRenderer.invoke('picker:choose', { reqId, sourceId, audio: Boolean(audio) }),
  cancelPick: (reqId) => ipcRenderer.invoke('picker:cancel', { reqId }),
});

ipcRenderer.on('app:open-invite', () => window.dispatchEvent(new Event('liveapp:open-invite')));
