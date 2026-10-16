// App desktop (Electron). Duas formas de uso, escolhidas na primeira abertura:
//  - "join": abre o servidor de um amigo (endereço colado pelo usuário);
//  - "host": sobe o servidor neste PC e mostra o endereço para os amigos.
const { app, BrowserWindow, session, desktopCapturer, Menu, shell, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const brand = require('../brand.config.json');

const DEFAULT_PORT = Number(new URL(brand.serverUrl).port) || 3000;
const configFile = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
let win = null;
let serverStarted = false;

// Voz e câmera exigem "contexto seguro". Servidor http em rede local/VPN não é HTTPS,
// então o endereço escolhido pelo usuário é marcado como seguro (antes do app iniciar).
if (config.mode === 'join' && config.serverUrl) {
  try { app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', new URL(config.serverUrl).origin); } catch { /* ignora */ }
}

function startServer() {
  if (serverStarted) return;
  process.env.PORT = String(DEFAULT_PORT);
  require('../server.js');
  serverStarted = true;
}

function normalizeUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = (/^[\d.]+(:\d+)?$/.test(value) || /^localhost/i.test(value) ? 'http://' : 'https://') + value;
  try {
    const u = new URL(value);
    return u.origin;
  } catch { return null; }
}

function appUrl() {
  if (config.mode === 'host') return `http://localhost:${DEFAULT_PORT}`;
  if (config.mode === 'join' && config.serverUrl) return config.serverUrl;
  return null;
}

function showSetup() {
  win.loadFile(path.join(__dirname, 'setup.html'));
}

// Volta para a tela de escolha de servidor (e desliga o servidor local, se havia um).
function leaveServer() {
  config = {};
  saveConfig(config);
  app.relaunch();
  app.exit(0);
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: brand.appName,
      submenu: [
        { label: 'Convidar amigos / endereço', click: () => win && win.webContents.send('app:open-invite') },
        { label: 'Sair do servidor', click: leaveServer },
        { type: 'separator' },
        { role: 'reload', label: 'Recarregar' },
        { role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' },
        { type: 'separator' },
        { role: 'quit', label: 'Sair' },
      ],
    },
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 600,
    title: brand.appName,
    backgroundColor: (brand.colors && brand.colors.bg) || '#1e1f22',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Pedidos de compartilhamento pendentes não sobrevivem a recarregar a página.
  win.webContents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) dropPendingShares();
  });

  // Se o servidor do amigo estiver fora do ar, volta para a tela de configuração.
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || url.startsWith('file:')) return;
    dialog.showMessageBox(win, {
      type: 'warning', title: 'Sem conexão',
      message: 'Não consegui conectar ao servidor.',
      detail: `${url}\n${desc} (${code})\n\nConfira se o servidor está ligado e o endereço está certo.`,
    }).then(showSetup);
  });

  const url = appUrl();
  if (url) {
    if (config.mode === 'host') startServer();
    win.loadURL(url);
  } else {
    showSetup();
  }
}

ipcMain.handle('setup:current', () => config);

ipcMain.handle('setup:choose', async (_e, { mode, url }) => {
  if (mode === 'join') {
    const serverUrl = normalizeUrl(url);
    if (!serverUrl) return { error: 'Endereço inválido.' };
    config = { mode: 'join', serverUrl };
    saveConfig(config);
    // O sinalizador de origem segura só vale na inicialização: reinicia o app.
    app.relaunch();
    app.exit(0);
    return {};
  }
  config = { mode: 'host' };
  saveConfig(config);
  startServer();
  buildMenu();
  await win.loadURL(`http://localhost:${DEFAULT_PORT}`);
  return {};
});

ipcMain.handle('app:leave-server', (e) => {
  if (win && e.sender === win.webContents) leaveServer();
});

// ---- Seletor de tela/janela: o site mostra a escolha, aqui só guardamos o pedido pendente.
const pendingShares = new Map();
let shareSeq = 0;

function dropPendingShares() {
  for (const p of pendingShares.values()) p.callback({});
  pendingShares.clear();
}

ipcMain.handle('picker:choose', (e, { reqId, sourceId, audio }) => {
  if (!win || e.sender !== win.webContents) return;
  const p = pendingShares.get(reqId);
  if (!p) return;
  pendingShares.delete(reqId);
  const source = p.sources.find((s) => s.id === sourceId);
  if (!source) return p.callback({});
  // 'loopback' captura todo o som do PC (inclusive a voz dos amigos): só quando a pessoa pedir.
  p.callback({ video: source, ...(audio && p.audioRequested ? { audio: 'loopback' } : {}) });
});

ipcMain.handle('picker:cancel', (e, { reqId }) => {
  if (!win || e.sender !== win.webContents) return;
  const p = pendingShares.get(reqId);
  if (!p) return;
  pendingShares.delete(reqId);
  p.callback({});
});

app.whenReady().then(() => {
  const ses = session.defaultSession;

  const allowed = new Set(['media', 'display-capture', 'audioCapture', 'videoCapture']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));

  // Compartilhamento de tela: envia as telas/janelas (com miniatura) para a interface do site,
  // que mostra o seletor no tema do app e devolve a escolha por IPC.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!win) return callback({});
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 480, height: 270 },
        fetchWindowIcons: true,
      });
      if (!sources.length) return callback({});
      const reqId = ++shareSeq;
      const audioRequested = Boolean(request.audioRequested);
      pendingShares.set(reqId, { callback, sources, audioRequested });
      win.webContents.send('picker:sources', {
        reqId,
        audioRequested,
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.id.startsWith('screen:') ? 'screen' : 'window',
          thumb: s.thumbnail.toDataURL(),
          icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        })),
      });
    } catch {
      callback({});
    }
  });

  buildMenu();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
