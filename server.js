// Servidor: entrega o site, guarda o chat em memória e repassa a sinalização WebRTC.
// A mídia (voz/câmera/tela) vai direto entre os navegadores (P2P), não passa por aqui.
//
// Uso:  node server.js            -> sobe na porta PORT (padrão 3000)
//       require('./server').createApp(porta) -> instância que pode ser ligada e desligada
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const brand = require('./brand.config.json');

const HISTORY_LIMIT = 100;

// Endereços em que este servidor pode ser alcançado, lidos a cada pedido
// (o IP muda quando a pessoa troca de rede, liga uma VPN etc.).
function classifyAddress(ip, ifaceName) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 169 && b === 254) return null; // sem rede de verdade (link-local)
  // Adaptadores de máquinas virtuais/contêineres: não são alcançáveis por amigos.
  if (/virtualbox|vmware|vmnet|vethernet|hyper-v|wsl|docker|loopback/i.test(ifaceName)) return null;
  if ((a === 192 && b === 56) || (a === 192 && b === 99) || (a === 172 && b === 17)) return null;
  if (a === 100 && b >= 64 && b <= 127) return { label: 'VPN Tailscale (só quem está na VPN)', rank: 1 };
  if (/tailscale|zerotier|radmin|hamachi|wireguard|vpn/i.test(ifaceName)) return { label: 'VPN (só quem está na mesma VPN)', rank: 1 };
  if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
    return { label: 'Mesma casa/Wi-Fi (não funciona de fora)', rank: 0 };
  }
  return { label: 'Outra rede', rank: 2 };
}

function lanAddresses(port) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const kind = classifyAddress(i.address, name);
      if (kind) out.push({ ip: i.address, iface: name, label: kind.label, rank: kind.rank, url: `http://${i.address}:${port}` });
    }
  }
  return out.sort((x, y) => x.rank - y.rank);
}

function createApp(port) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  let publicUrl = null;

  const history = Object.fromEntries(brand.channels.map((c) => [c, []]));
  // socket.id -> { name, channel, media: { mic, cam, screen } }
  const users = new Map();

  app.use(express.static(path.join(__dirname, 'public')));

  // Configuração pública para o cliente (sem o código de acesso).
  app.get('/brand.json', (_req, res) => {
    const { accessCode, ...pub } = brand;
    res.json({ ...pub, requiresCode: Boolean(accessCode) });
  });

  // Só quem já entrou (tem sessão) vê os endereços da máquina.
  app.get('/server-info', (req, res) => {
    if (!users.has(String(req.query.id || ''))) return res.status(403).json({ error: 'Entre primeiro.' });
    res.json({ name: brand.appName, port, online: users.size, publicUrl, addresses: lanAddresses(port) });
  });

  function channelMembers(channel) {
    return [...users.entries()]
      .filter(([, u]) => u.channel === channel)
      .map(([id, u]) => ({ id, name: u.name, media: u.media }));
  }

  function broadcastPresence() {
    const presence = Object.fromEntries(
      brand.channels.map((c) => [c, channelMembers(c).map((m) => m.name)])
    );
    io.emit('presence', presence);
  }

  function leaveChannel(socket) {
    const u = users.get(socket.id);
    if (!u || !u.channel) return;
    socket.to(u.channel).emit('peer-left', { id: socket.id });
    socket.leave(u.channel);
    u.channel = null;
  }

  io.on('connection', (socket) => {
    socket.on('login', ({ name, code }, ack) => {
      if (brand.accessCode && code !== brand.accessCode) return ack({ error: 'Código de acesso inválido.' });
      const clean = String(name || '').trim().slice(0, 32);
      if (!clean) return ack({ error: 'Digite um nome.' });
      users.set(socket.id, { name: clean, channel: null, media: { mic: false, cam: false, screen: false } });
      ack({ ok: true, id: socket.id });
      broadcastPresence();
    });

    socket.on('join', ({ channel }, ack) => {
      const u = users.get(socket.id);
      if (!u || !brand.channels.includes(channel)) return ack({ error: 'Canal inválido.' });
      if (channelMembers(channel).length >= brand.maxPeersPerChannel) return ack({ error: 'Canal cheio.' });
      leaveChannel(socket);
      const peers = channelMembers(channel);
      u.channel = channel;
      socket.join(channel);
      // Quem chega recebe a lista e inicia as conexões; os demais só são avisados.
      ack({ ok: true, peers, history: history[channel] });
      socket.to(channel).emit('peer-joined', { id: socket.id, name: u.name, media: u.media });
      broadcastPresence();
    });

    socket.on('leave', () => {
      leaveChannel(socket);
      broadcastPresence();
    });

    socket.on('chat', ({ text }) => {
      const u = users.get(socket.id);
      const clean = String(text || '').trim().slice(0, 2000);
      if (!u || !u.channel || !clean) return;
      const msg = { from: u.name, text: clean, at: Date.now() };
      const h = history[u.channel];
      h.push(msg);
      if (h.length > HISTORY_LIMIT) h.shift();
      io.to(u.channel).emit('chat', msg);
    });

    socket.on('rename', ({ name }, ack) => {
      const u = users.get(socket.id);
      const clean = String(name || '').trim().slice(0, 32);
      if (!u || !clean) return ack({ error: 'Nome inválido.' });
      u.name = clean;
      if (u.channel) socket.to(u.channel).emit('peer-renamed', { id: socket.id, name: clean });
      broadcastPresence();
      ack({ ok: true, name: clean });
    });

    socket.on('media', (media) => {
      const u = users.get(socket.id);
      if (!u) return;
      u.media = { mic: !!media.mic, cam: !!media.cam, screen: !!media.screen };
      if (u.channel) socket.to(u.channel).emit('peer-media', { id: socket.id, media: u.media });
    });

    // Repasse de sinalização somente entre pessoas do mesmo canal.
    socket.on('signal', ({ to, data }) => {
      const from = users.get(socket.id);
      const target = users.get(to);
      if (!from || !target || !from.channel || from.channel !== target.channel) return;
      io.to(to).emit('signal', { from: socket.id, data });
    });

    socket.on('disconnect', () => {
      leaveChannel(socket);
      users.delete(socket.id);
      broadcastPresence();
    });
  });

  return {
    get port() { return port; },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.off('error', reject);
          resolve(port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        io.close(() => resolve()); // também fecha o servidor HTTP
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
    setPublicUrl(url) { publicUrl = url || null; },
  };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp(port).start().then(
    () => console.log(`${brand.appName} rodando em http://localhost:${port}`),
    (err) => { console.error(`Não consegui abrir a porta ${port}: ${err.message}`); process.exit(1); }
  );
}
