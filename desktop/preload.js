const { contextBridge, ipcRenderer } = require('electron');

// Tela de escolha de servidor (setup.html).
contextBridge.exposeInMainWorld('setup', {
  choose: (opts) => ipcRenderer.invoke('setup:choose', opts),
  current: () => ipcRenderer.invoke('setup:current'),
});

// Recursos do app de desktop para a interface do site (seletor de tela, sair do servidor).
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  onPickSources: (cb) => ipcRenderer.on('picker:sources', (_e, payload) => cb(payload)),
  pickSource: (reqId, sourceId, audio) => ipcRenderer.invoke('picker:choose', { reqId, sourceId, audio: Boolean(audio) }),
  cancelPick: (reqId) => ipcRenderer.invoke('picker:cancel', { reqId }),
  leaveServer: () => ipcRenderer.invoke('app:leave-server'),
});

ipcRenderer.on('app:open-invite', () => window.dispatchEvent(new Event('liveapp:open-invite')));
