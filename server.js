// Servidor: entrega o site, guarda o chat em memória e repassa a sinalização WebRTC.
// A mídia (voz/câmera/tela) vai direto entre os navegadores (P2P), não passa por aqui.
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const brand = require('./brand.config.json');

const PORT = process.env.PORT || 3000;
const HISTORY_LIMIT = 100;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Configuração pública para o cliente (sem o código de acesso).
app.get('/brand.json', (_req, res) => {
  const { accessCode, ...pub } = brand;
  res.json({ ...pub, requiresCode: Boolean(accessCode) });
});

const history = Object.fromEntries(brand.channels.map((c) => [c, []]));
// socket.id -> { name, channel, media: { mic, cam, screen } }
const users = new Map();

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

server.listen(PORT, () => {
  console.log(`${brand.appName} rodando em http://localhost:${PORT}`);
});
