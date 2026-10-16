// App desktop (Electron). Duas formas de uso, escolhidas na primeira abertura:
//  - "join": abre o servidor de um amigo (endereço colado pelo usuário);
//  - "host": sobe o servidor neste PC e pode gerar um link público (HTTPS) para a internet.
// Entrar e sair de servidor acontece dentro do mesmo processo, sem reiniciar o app.
const { app, BrowserWindow, session, desktopCapturer, Menu, shell, ipcMain, dialog, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const brand = require('../brand.config.json');
const { createApp } = require('../server.js');

const BASE_PORT = Number(new URL(brand.serverUrl).port) || 3000;
const configFile = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

let config = loadConfig();
let win = null;

const isLoopback = (h) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h);

// ---------------------------------------------------------------- servidor próprio
let hostServer = null;
let hostPort = null;

async function startHosting() {
  if (hostServer) return hostPort;
  let lastErr;
  // Se a porta padrão estiver ocupada (outra cópia do app, por exemplo), tenta as próximas.
  for (let p = BASE_PORT; p < BASE_PORT + 10; p += 1) {
    const s = createApp(p);
    try {
      await s.start();
      hostServer = s;
      hostPort = p;
      applyTurn();
      return p;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EADDRINUSE') break;
    }
  }
  throw lastErr;
}

// Servidor TURN (relay) escolhido por quem hospeda; vale para todos que entram neste servidor.
// Sem ele, amigos atrás de NAT restritivo (CGNAT, 4G...) não recebem áudio nem vídeo.
function cleanTurn(t) {
  if (!t || typeof t !== 'object') return null;
  const urls = (Array.isArray(t.urls) ? t.urls : String(t.urls || '').split(/[\s,]+/))
    .map((u) => String(u).trim())
    .filter((u) => /^(turns?|stuns?):[^\s]+$/i.test(u))
    .slice(0, 8);
  if (!urls.length) return null;
  return { urls, username: String(t.username || '').slice(0, 200), credential: String(t.credential || '').slice(0, 400) };
}

function applyTurn() {
  if (!hostServer) return;
  const turn = cleanTurn(config.turn);
  hostServer.setIceServers(turn ? [...brand.iceServers, turn] : null);
}

async function stopHosting() {
  const s = hostServer;
  hostServer = null;
  hostPort = null;
  if (s) await s.close();
}

// ---------------------------------------------------------------- link público (túnel)
let tunnel = null;
let tunnelUrl = null;
let tunnelBusy = false;

function resolveCloudflared(cf) {
  // Dentro do app empacotado o binário fica em app.asar.unpacked.
  const unpacked = cf.bin.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  if (fs.existsSync(unpacked)) return unpacked;
  return path.join(app.getPath('userData'), process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

async function startTunnel() {
  if (tunnelUrl) return tunnelUrl;
  if (!hostServer) throw new Error('O servidor não está ligado.');
  if (tunnelBusy) throw new Error('Já estou criando o link.');
  tunnelBusy = true;
  try {
    const cf = require('cloudflared');
    const bin = resolveCloudflared(cf);
    cf.use(bin);
    if (!fs.existsSync(bin)) await cf.install(bin); // baixa o cloudflared só se faltar

    const t = cf.Tunnel.quick(`http://localhost:${hostPort}`);
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { t.stop(); reject(new Error('Tempo esgotado ao criar o link.')); }, 45000);
      t.once('url', (u) => { clearTimeout(timer); resolve(u); });
      t.once('error', (e) => { clearTimeout(timer); reject(e); });
      t.once('exit', () => { clearTimeout(timer); reject(new Error('O túnel foi encerrado.')); });
    });
    tunnel = t;
    tunnelUrl = url;
    hostServer.setPublicUrl(url);
    t.once('exit', () => {
      if (tunnel === t) { tunnel = null; tunnelUrl = null; if (hostServer) hostServer.setPublicUrl(null); }
    });
    return url;
  } finally {
    tunnelBusy = false;
  }
}

function stopTunnel() {
  const t = tunnel;
  tunnel = null;
  tunnelUrl = null;
  if (hostServer) hostServer.setPublicUrl(null);
  if (t) { try { t.stop(); } catch { /* já encerrado */ } }
}

// ---------------------------------------------------------------- proxy local
// Voz e câmera exigem "contexto seguro" (HTTPS ou localhost). Um servidor http://IP não é.
// Então o app abre o servidor do amigo através de um proxy em 127.0.0.1, que é seguro,
// sem precisar de flags de inicialização (e, portanto, sem reiniciar o app).
let proxy = null;

function startProxy(target) {
  const t = new URL(target);
  const secure = t.protocol === 'https:';
  const lib = secure ? https : http;
  const port = Number(t.port) || (secure ? 443 : 80);
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: t.host };
    if (headers.origin) headers.origin = t.origin;
    const up = lib.request({ hostname: t.hostname, port, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Servidor indisponível.'); });
    req.pipe(up);
  });

  server.on('upgrade', (req, socket, head) => {
    const up = secure
      ? tls.connect({ host: t.hostname, port, servername: t.hostname })
      : net.connect(port, t.hostname);
    sockets.add(socket);
    sockets.add(up);
    const done = () => { sockets.delete(socket); sockets.delete(up); socket.destroy(); up.destroy(); };
    up.on('error', done);
    socket.on('error', done);
    up.on('close', done);
    socket.on('close', done);
    up.once(secure ? 'secureConnect' : 'connect', () => {
      const headers = { ...req.headers, host: t.host };
      if (headers.origin) headers.origin = t.origin;
      const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines}\r\n\r\n`);
      if (head && head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => {
          sockets.forEach((s) => s.destroy());
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          server.close(() => r());
        }),
      });
    });
  });
}

async function stopProxy() {
  const p = proxy;
  proxy = null;
  if (p) await p.close();
}

// ---------------------------------------------------------------- utilidades
function normalizeUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) {
    value = (/^[\d.]+(:\d+)?$/.test(value) || /^localhost/i.test(value) ? 'http://' : 'https://') + value;
  }
  try { return new URL(value).origin; } catch { return null; }
}

function probe(urlStr, ms = 8000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/brand.json', urlStr); } catch { return resolve({ error: 'Endereço inválido.' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: ms }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? { ok: true } : { error: `O servidor respondeu ${res.statusCode}.` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

function connectMessage(url, reason) {
  const host = new URL(url).hostname;
  const privateIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  let msg = `Não consegui conectar em ${url} (${reason}).`;
  if (privateIp) {
    msg += ' Esse é um endereço de rede local: só funciona para quem está na mesma casa/Wi-Fi. ' +
      'De fora, use o "Link público" do anfitrião ou uma VPN.';
  } else {
    msg += ' Confira se o endereço está certo e se o servidor está ligado.';
  }
  return msg;
}

// ---------------------------------------------------------------- navegação entre telas
function showSetup() {
  win.loadFile(path.join(__dirname, 'setup.html'));
}

async function loadApp() {
  try {
    if (config.mode === 'host') {
      const port = await startHosting();
      if (config.autoTunnel) startTunnel().catch(() => { /* o painel de convite mostra o botão de novo */ });
      await win.loadURL(`http://localhost:${port}`);
      return { ok: true };
    }
    if (config.mode === 'join' && config.serverUrl) {
      const u = new URL(config.serverUrl);
      let target = config.serverUrl;
      if (u.protocol === 'http:' && !isLoopback(u.hostname)) {
        await stopProxy();
        proxy = await startProxy(config.serverUrl);
        target = proxy.url;
      }
      await win.loadURL(target);
      return { ok: true };
    }
    showSetup();
    return { ok: true };
  } catch (err) {
    if (err && (err.code === 'ERR_ABORTED' || err.errno === -3)) return { ok: true };
    const message = err && err.code === 'EADDRINUSE'
      ? 'As portas 3000 a 3009 estão ocupadas. Feche outra cópia do app ou do servidor.'
      : `Falha ao abrir: ${(err && err.message) || err}`;
    return { error: message };
  }
}

async function leaveServer() {
  showSetup();
  stopTunnel();
  await stopProxy();
  await stopHosting();
  config = {};
  saveConfig();
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: brand.appName,
      submenu: [
        { label: 'Convidar amigos / endereço', click: () => win && win.webContents.send('app:open-invite') },
        { label: 'Sair do servidor', click: () => leaveServer() },
        { type: 'separator' },
        { role: 'reload', label: 'Recarregar' },
        { role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' },
        { type: 'separator' },
        { role: 'quit', label: 'Sair do aplicativo' },
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

  showSetup();
  if (config.mode) {
    // Servidor salvo: tenta abrir; se falhar, volta para a tela de escolha com o motivo.
    (async () => {
      if (config.mode === 'join' && config.serverUrl) {
        const p = await probe(config.serverUrl);
        if (p.error) {
          await dialog.showMessageBox(win, {
            type: 'warning', title: 'Sem conexão', message: 'Não consegui abrir o servidor salvo.',
            detail: connectMessage(config.serverUrl, p.error),
          });
          return;
        }
      }
      const r = await loadApp();
      if (r.error) {
        await dialog.showMessageBox(win, { type: 'warning', title: 'Erro', message: r.error });
        showSetup();
      }
    })();
  }
}

// ---------------------------------------------------------------- IPC
const fromWindow = (e) => win && e.sender === win.webContents;

ipcMain.handle('setup:current', () => config);

ipcMain.handle('setup:choose', async (e, { mode, url }) => {
  if (!fromWindow(e)) return { error: 'Não permitido.' };
  if (mode === 'join') {
    const serverUrl = normalizeUrl(url);
    if (!serverUrl) return { error: 'Endereço inválido.' };
    const p = await probe(serverUrl);
    if (p.error) return { error: connectMessage(serverUrl, p.error) };
    config = { mode: 'join', serverUrl };
    saveConfig();
    return loadApp();
  }
  config = { mode: 'host', autoTunnel: Boolean(config.autoTunnel) };
  saveConfig();
  return loadApp();
});

ipcMain.handle('app:info', (e) => {
  if (!fromWindow(e)) return null;
  return {
    mode: config.mode || null,
    version: app.getVersion(),
    serverUrl: config.serverUrl || null,
    tunnelUrl,
    tunnelBusy,
    canTunnel: config.mode === 'host',
  };
});

ipcMain.handle('turn:get', (e) => {
  if (!fromWindow(e) || config.mode !== 'host') return null;
  return cleanTurn(config.turn);
});

ipcMain.handle('turn:set', (e, turn) => {
  if (!fromWindow(e) || config.mode !== 'host') return { error: 'Só quem hospeda pode configurar.' };
  const clean = turn ? cleanTurn(turn) : null;
  if (turn && !clean) return { error: 'Informe pelo menos um endereço turn: ou turns:.' };
  config.turn = clean || undefined;
  saveConfig();
  applyTurn();
  return { ok: true };
});

ipcMain.handle('tunnel:start', async (e) => {
  if (!fromWindow(e) || config.mode !== 'host') return { error: 'Só quem hospeda pode criar o link.' };
  try {
    const url = await startTunnel();
    config.autoTunnel = true;
    saveConfig();
    return { url };
  } catch (err) {
    return { error: (err && err.message) || 'Não consegui criar o link público.' };
  }
});

ipcMain.handle('tunnel:stop', (e) => {
  if (!fromWindow(e)) return;
  stopTunnel();
  config.autoTunnel = false;
  saveConfig();
});

ipcMain.handle('app:leave-server', (e) => {
  if (fromWindow(e)) leaveServer();
});

// ---- Atalhos globais (valem com o app em segundo plano) ----
const SHORTCUT_ACTIONS = ['mic', 'deaf', 'cam', 'screen', 'full', 'leave'];
const ACCEL_KEYS = {
  Space: 'Space', Enter: 'Return', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

// "Ctrl+Shift+M" (formato do app) -> acelerador do Electron; null se não for válido.
function toAccelerator(combo) {
  const parts = String(combo || '').split('+');
  const key = parts.pop();
  const mods = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Super' };
  if (!parts.every((p) => mods[p])) return null;
  // Sem Ctrl/Alt/Win a tecla seria roubada do sistema inteiro.
  if (!parts.some((p) => p === 'Ctrl' || p === 'Alt' || p === 'Meta')) return null;
  let k = ACCEL_KEYS[key] || key;
  if (!(/^[A-Z0-9]$/.test(k) || /^F([1-9]|1\d|2[0-4])$/.test(k) || Object.values(ACCEL_KEYS).includes(k))) return null;
  return [...parts.map((p) => mods[p]), k].join('+');
}

ipcMain.handle('shortcuts:set', (e, { enabled, keys }) => {
  if (!fromWindow(e)) return { failed: [] };
  globalShortcut.unregisterAll();
  const failed = [];
  if (!enabled || !keys || typeof keys !== 'object') return { failed };
  const used = new Set();
  for (const id of SHORTCUT_ACTIONS) {
    const combo = keys[id];
    if (!combo) continue;
    const accel = toAccelerator(combo);
    if (!accel) continue; // combinação sem modificador: fica só como atalho local
    if (used.has(accel)) { failed.push(id); continue; }
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => {
        if (win && !win.isDestroyed()) win.webContents.send('shortcut:action', id);
      });
    } catch { ok = false; }
    if (ok) used.add(accel); else failed.push(id);
  }
  return { failed };
});

// ---- Seletor de tela/janela: o site mostra a escolha, aqui só guardamos o pedido pendente.
const pendingShares = new Map();
let shareSeq = 0;

function dropPendingShares() {
  for (const p of pendingShares.values()) p.callback({});
  pendingShares.clear();
}

ipcMain.handle('picker:choose', (e, { reqId, sourceId, audio }) => {
  if (!fromWindow(e)) return;
  const p = pendingShares.get(reqId);
  if (!p) return;
  pendingShares.delete(reqId);
  const source = p.sources.find((s) => s.id === sourceId);
  if (!source) return p.callback({});
  // 'loopback' captura todo o som do PC (inclusive a voz dos amigos): só quando a pessoa pedir.
  p.callback({ video: source, ...(audio && p.audioRequested ? { audio: 'loopback' } : {}) });
});

ipcMain.handle('picker:cancel', (e, { reqId }) => {
  if (!fromWindow(e)) return;
  const p = pendingShares.get(reqId);
  if (!p) return;
  pendingShares.delete(reqId);
  p.callback({});
});

// ---------------------------------------------------------------- ciclo de vida
app.whenReady().then(() => {
  const ses = session.defaultSession;

  // 'fullscreen' é o que o botão de tela cheia do vídeo pede ao Electron.
  const allowed = new Set([
    'media', 'display-capture', 'audioCapture', 'videoCapture', 'fullscreen', 'clipboard-sanitized-write',
  ]);
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

app.on('before-quit', () => { stopTunnel(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
