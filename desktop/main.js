// App desktop (Electron). Duas formas de uso, escolhidas na primeira abertura:
//  - "join": abre o servidor de um amigo (endereço colado pelo usuário);
//  - "host": sobe o servidor neste PC e mostra o endereço para os amigos.
const { app, BrowserWindow, session, desktopCapturer, Menu, shell, ipcMain, dialog, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
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

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
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

async function showHostInfo() {
  const ips = lanAddresses().map((ip) => `http://${ip}:${DEFAULT_PORT}`);
  const detail = [
    'Mesma rede (Wi-Fi/cabo) ou VPN tipo Tailscale/Radmin:',
    ...(ips.length ? ips : ['(nenhuma rede encontrada)']),
    '',
    'Pela internet (com HTTPS), em outro terminal:',
    `cloudflared tunnel --url http://localhost:${DEFAULT_PORT}`,
    '',
    'Mande o endereço que aparecer para os amigos.',
  ].join('\n');
  const { response } = await dialog.showMessageBox(win, {
    type: 'info', title: 'Endereço para os amigos', message: 'Seu servidor está no ar', detail,
    buttons: ips.length ? ['Copiar primeiro endereço', 'OK'] : ['OK'],
  });
  if (ips.length && response === 0) clipboard.writeText(ips[0]);
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: brand.appName,
      submenu: [
        { label: 'Endereço para os amigos', enabled: config.mode === 'host', click: showHostInfo },
        { label: 'Trocar servidor / modo', click: () => { config = {}; saveConfig(config); app.relaunch(); app.exit(0); } },
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
  showHostInfo();
  return {};
});

app.whenReady().then(() => {
  const ses = session.defaultSession;

  const allowed = new Set(['media', 'display-capture', 'audioCapture', 'videoCapture']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));

  // Seletor de tela/janela para o compartilhamento (o Electron não traz um pronto).
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      if (!sources.length) return callback({});
      const menu = Menu.buildFromTemplate([
        { label: 'Compartilhar:', enabled: false },
        { type: 'separator' },
        ...sources.map((s) => ({
          label: s.name.slice(0, 60),
          click: () => callback({ video: s, audio: 'loopback' }),
        })),
        { type: 'separator' },
        { label: 'Cancelar', click: () => callback({}) },
      ]);
      menu.popup({ callback: () => {} });
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
