// Cliente: chat + chamada em malha WebRTC (cada pessoa conecta direto com as outras).
(async function () {
  const $ = (s) => document.querySelector(s);
  const brand = await (await fetch('/brand.json')).json();
  const socket = io();

  const state = {
    me: null, // { id, name }
    code: '',
    channel: null,
    deaf: false,
    micWanted: true,
    micTrack: null,
    camTrack: null,
    screenTracks: [],
    peers: new Map(),
  };
  const localCam = new MediaStream(); // mic + câmera
  const localScreen = new MediaStream(); // tela (+ áudio do sistema)

  // ---------- Marca (white label) ----------
  function applyBrand() {
    const c = brand.colors || {};
    const map = {
      accent: '--accent', accentText: '--accent-text', bg: '--bg', panel: '--panel',
      panelAlt: '--panel-alt', text: '--text', muted: '--muted', danger: '--danger', success: '--success',
    };
    for (const [k, v] of Object.entries(map)) if (c[k]) document.documentElement.style.setProperty(v, c[k]);
    document.title = brand.appName;
    document.querySelectorAll('[data-app-name]').forEach((e) => (e.textContent = brand.appName));
    document.querySelectorAll('[data-tagline]').forEach((e) => (e.textContent = brand.tagline || ''));
    document.querySelectorAll('[data-logo]').forEach((e) => {
      if (brand.logoUrl) e.style.backgroundImage = `url("${brand.logoUrl}")`;
      else e.textContent = brand.logoText || brand.appName.slice(0, 2).toUpperCase();
    });
    if (brand.requiresCode) $('#login-code').hidden = false;
  }
  applyBrand();

  // ---------- Utilidades ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }
  const initial = (n) => (n || '?').trim().slice(0, 1).toUpperCase();
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
  };

  // ---------- Preferências (ficam só neste computador) ----------
  const defaults = {
    mic: '', spk: '', cam: '', ns: true, ec: true, agc: true, vol: 100,
    res: '1080', fps: '30', bitrate: '3000000', sysaudio: false, accent: '',
  };
  const settings = { ...defaults };
  try { Object.assign(settings, JSON.parse(store.get('liveapp.settings') || '{}')); } catch { /* usa o padrão */ }
  const saveSettings = () => store.set('liveapp.settings', JSON.stringify(settings));

  function readableOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 150 ? '#111111' : '#ffffff';
  }
  function applyAccent() {
    const root = document.documentElement.style;
    const c = brand.colors || {};
    if (settings.accent) {
      root.setProperty('--accent', settings.accent);
      root.setProperty('--accent-text', readableOn(settings.accent));
    } else {
      if (c.accent) root.setProperty('--accent', c.accent);
      if (c.accentText) root.setProperty('--accent-text', c.accentText);
    }
  }
  applyAccent();

  // Tenta o dispositivo escolhido; se ele sumiu, cai no padrão do sistema.
  async function getMicStream() {
    const base = { echoCancellation: settings.ec, noiseSuppression: settings.ns, autoGainControl: settings.agc };
    if (settings.mic) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: settings.mic } } });
      } catch { /* dispositivo indisponível */ }
    }
    return navigator.mediaDevices.getUserMedia({ audio: base });
  }
  async function getCamStream() {
    const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    if (settings.cam) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: { ...base, deviceId: { exact: settings.cam } } });
      } catch { /* dispositivo indisponível */ }
    }
    return navigator.mediaDevices.getUserMedia({ video: base });
  }

  function applyOutput(video) {
    video.volume = Math.min(1, Math.max(0, Number(settings.vol) / 100));
    if (settings.spk && typeof video.setSinkId === 'function') video.setSinkId(settings.spk).catch(() => {});
  }
  function applyOutputAll() {
    for (const p of state.peers.values()) {
      applyOutput(p.tile.video);
      if (p.screenTile) applyOutput(p.screenTile.video);
    }
  }

  // ---------- Login ----------
  $('#login-name').value = store.get('liveapp.name');
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#login-name').value;
    const code = $('#login-code').value;
    const res = await login(name, code);
    if (res.error) { $('#login-error').textContent = res.error; return; }
    store.set('liveapp.name', name);
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#me-name').textContent = state.me.name;
    renderChannels({});
    maybeAutoInvite();
  });

  function login(name, code) {
    return new Promise((resolve) => {
      socket.emit('login', { name, code }, (res) => {
        if (res.ok) { state.me = { id: res.id, name: String(name).trim() }; state.code = code; }
        resolve(res);
      });
    });
  }

  // ---------- Canais ----------
  const channelsEl = $('#channels');
  let presence = {};
  function renderChannels(p) {
    presence = p;
    channelsEl.textContent = '';
    for (const ch of brand.channels) {
      const btn = document.createElement('button');
      btn.className = 'channel' + (state.channel === ch ? ' active' : '');
      btn.textContent = '🔊 ' + ch;
      const members = p[ch] || [];
      if (members.length) {
        const ul = document.createElement('ul');
        ul.className = 'members';
        members.forEach((m) => { const li = document.createElement('li'); li.textContent = m; ul.append(li); });
        btn.append(ul);
      }
      btn.addEventListener('click', () => { join(ch); $('.sidebar').classList.remove('open'); });
      channelsEl.append(btn);
    }
  }
  socket.on('presence', renderChannels);

  // ---------- Mídia local ----------
  async function ensureMic() {
    if (state.micTrack) return true;
    try {
      const s = await getMicStream();
      state.micTrack = s.getAudioTracks()[0];
      state.micTrack.enabled = state.micWanted && !state.deaf;
      localCam.addTrack(state.micTrack);
      addTrackToAll(state.micTrack, localCam);
      watchSpeaking(selfTile, new MediaStream([state.micTrack]), () => state.micTrack && state.micTrack.enabled);
      return true;
    } catch {
      toast('Não consegui acessar o microfone. Verifique a permissão do navegador.');
      return false;
    }
  }

  async function toggleCam() {
    if (!state.channel) return;
    if (state.camTrack) return stopCam();
    try {
      const s = await getCamStream();
      state.camTrack = s.getVideoTracks()[0];
      state.camTrack.onended = stopCam;
      localCam.addTrack(state.camTrack);
      addTrackToAll(state.camTrack, localCam);
      refreshSelf();
    } catch {
      toast('Não consegui acessar a câmera.');
    }
  }
  function stopCam() {
    const t = state.camTrack;
    if (!t) return;
    state.camTrack = null;
    t.stop();
    localCam.removeTrack(t);
    removeTrackFromAll(t);
    refreshSelf();
  }

  async function toggleScreen() {
    if (!state.channel) return;
    if (state.screenTracks.length) return stopScreen();
    try {
      const height = settings.res === 'source' ? null : Number(settings.res);
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: Number(settings.fps) || 30 }, ...(height ? { height: { ideal: height } } : {}) },
        audio: Boolean(settings.sysaudio),
      });
      for (const t of s.getTracks()) {
        if (t.kind === 'video') { t.contentHint = 'detail'; t.onended = stopScreen; }
        state.screenTracks.push(t);
        localScreen.addTrack(t);
        addTrackToAll(t, localScreen);
      }
      refreshSelf();
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') toast('Não foi possível compartilhar a tela.');
    }
  }
  function stopScreen() {
    const tracks = state.screenTracks;
    if (!tracks.length) return;
    state.screenTracks = [];
    for (const t of tracks) {
      t.stop();
      localScreen.removeTrack(t);
      removeTrackFromAll(t);
    }
    refreshSelf();
  }

  function addTrackToAll(track, stream) {
    for (const peer of state.peers.values()) addTrackToPeer(peer, track, stream);
  }
  function addTrackToPeer(peer, track, stream) {
    if (peer.senders.has(track)) return;
    const sender = peer.pc.addTrack(track, stream);
    peer.senders.set(track, sender);
    if (stream === localScreen && track.kind === 'video') {
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = Number(settings.bitrate) || 3_000_000;
        sender.setParameters(p).catch(() => {});
      } catch { /* aplicado na renegociação */ }
    }
  }
  function removeTrackFromAll(track) {
    for (const peer of state.peers.values()) {
      const sender = peer.senders.get(track);
      if (!sender) continue;
      peer.senders.delete(track);
      try { peer.pc.removeTrack(sender); } catch { /* conexão já fechada */ }
    }
  }

  function emitMedia() {
    socket.emit('media', {
      mic: Boolean(state.micTrack && state.micTrack.enabled),
      cam: Boolean(state.camTrack),
      screen: state.screenTracks.length > 0,
    });
  }

  // ---------- Blocos de vídeo ----------
  const grid = $('#grid');
  let selfTile = null;
  const speakers = new Set();

  function makeTile({ name, mirror = false, muted = false, screen = false }) {
    const el = document.createElement('div');
    el.className = 'tile' + (screen ? ' screen' : '');
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = muted;
    if (mirror) video.classList.add('mirror');
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initial(name);
    const label = document.createElement('div');
    label.className = 'label';
    const labelText = document.createElement('span');
    labelText.textContent = screen ? `${name} (tela)` : name;
    const flags = document.createElement('span');
    label.append(flags, labelText);
    el.append(video, avatar, label);
    el.addEventListener('click', () => toggleFocus(el));
    grid.append(el);
    const tile = { el, video, flags, analyser: null, stream: null };
    tile.setName = (n) => {
      labelText.textContent = screen ? `${n} (tela)` : n;
      avatar.textContent = initial(n);
    };
    if (!muted) applyOutput(video);
    return tile;
  }

  function toggleFocus(el) {
    const was = el.classList.contains('focused');
    grid.querySelectorAll('.tile.focused').forEach((t) => t.classList.remove('focused'));
    el.classList.toggle('focused', !was);
    grid.classList.toggle('has-focus', !was);
  }
  function removeTile(tile) {
    if (!tile) return;
    speakers.delete(tile);
    if (tile.el.classList.contains('focused')) {
      grid.classList.remove('has-focus');
    }
    tile.el.remove();
  }

  function setTileStream(tile, stream) {
    tile.stream = stream;
    tile.video.srcObject = stream;
    tile.video.muted = tile.video.muted || state.deaf;
    const refresh = () => {
      tile.el.classList.toggle('has-video', stream.getVideoTracks().length > 0);
      if (!tile.analyser && stream.getAudioTracks().length) watchSpeaking(tile, stream);
    };
    stream.onaddtrack = refresh;
    stream.onremovetrack = () => {
      refresh();
      if (tile.isScreen && stream.getTracks().length === 0) {
        const peer = state.peers.get(tile.peerId);
        if (peer && peer.screenTile === tile) peer.screenTile = null;
        removeTile(tile);
      }
    };
    refresh();
  }

  function refreshSelf() {
    if (!selfTile) return;
    const hasCam = Boolean(state.camTrack);
    selfTile.el.classList.toggle('has-video', hasCam);
    selfTile.video.srcObject = hasCam ? localCam : null;
    if (state.screenTracks.length) {
      if (!selfTile.screen) {
        selfTile.screen = makeTile({ name: state.me.name, muted: true, screen: true });
        selfTile.screen.video.srcObject = localScreen;
        selfTile.screen.el.classList.add('has-video');
      }
    } else if (selfTile.screen) {
      removeTile(selfTile.screen);
      selfTile.screen = null;
    }
    updateControls();
    emitMedia();
  }

  function setFlags(tile, media) {
    tile.flags.textContent = media && !media.mic ? '🔇' : '';
  }

  // Detecção de quem está falando (borda verde).
  let audioCtx = null;
  function watchSpeaking(tile, stream, isActive = () => true) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      tile.analyser = analyser;
      tile.isActive = isActive;
      speakers.add(tile);
    } catch { /* sem indicador de fala */ }
  }
  const buf = new Uint8Array(512);
  setInterval(() => {
    for (const tile of speakers) {
      if (!tile.analyser) continue;
      tile.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      const speaking = Math.sqrt(sum / buf.length) > 0.04 && (!tile.isActive || tile.isActive());
      tile.el.classList.toggle('speaking', speaking);
    }
  }, 150);

  // ---------- Conexões entre pessoas ----------
  function sendSignal(to, data) { socket.emit('signal', { to, data }); }

  function createPeer({ id, name, media }) {
    if (state.peers.has(id)) return state.peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: brand.iceServers });
    const peer = {
      id, name, media, pc, meta: null, senders: new Map(),
      polite: state.me.id < id, makingOffer: false, ignoreOffer: false,
      tile: null, screenTile: null,
    };
    state.peers.set(id, peer);

    peer.tile = makeTile({ name });
    peer.tile.peerId = id;
    setFlags(peer.tile, media);

    pc.onicecandidate = ({ candidate }) => { if (candidate) sendSignal(id, { candidate }); };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(id, { description: pc.localDescription });
      } catch { /* tenta de novo na próxima mudança */ } finally {
        peer.makingOffer = false;
      }
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      attachRemote(peer, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
    };

    // Diz ao outro lado qual stream é câmera e qual é tela (a ordem do socket é garantida).
    sendSignal(id, { meta: { cam: localCam.id, screen: localScreen.id } });
    localCam.getTracks().forEach((t) => addTrackToPeer(peer, t, localCam));
    localScreen.getTracks().forEach((t) => addTrackToPeer(peer, t, localScreen));
    return peer;
  }

  function attachRemote(peer, stream) {
    const isScreen = peer.meta && stream.id === peer.meta.screen;
    if (!isScreen) {
      setTileStream(peer.tile, stream);
      return;
    }
    if (!peer.screenTile) {
      const tile = makeTile({ name: peer.name, screen: true });
      tile.isScreen = true;
      tile.peerId = peer.id;
      peer.screenTile = tile;
      toggleFocus(tile.el); // quem entra numa tela compartilhada já a vê em destaque
    }
    setTileStream(peer.screenTile, stream);
  }

  function closePeer(id) {
    const peer = state.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    removeTile(peer.tile);
    removeTile(peer.screenTile);
    state.peers.delete(id);
  }

  socket.on('signal', async ({ from, data }) => {
    const peer = state.peers.get(from);
    if (!peer) return;
    const { pc } = peer;
    try {
      if (data.meta) { peer.meta = data.meta; return; }
      if (data.description) {
        const collision =
          data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          sendSignal(from, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (err) { if (!peer.ignoreOffer) throw err; }
      }
    } catch { /* sinalização inválida ou fora de ordem */ }
  });

  socket.on('peer-joined', (p) => {
    createPeer(p);
    addSystem(`${p.name} entrou`);
  });
  socket.on('peer-left', ({ id }) => {
    const peer = state.peers.get(id);
    if (peer) addSystem(`${peer.name} saiu`);
    closePeer(id);
  });
  socket.on('peer-renamed', ({ id, name }) => {
    const peer = state.peers.get(id);
    if (!peer) return;
    peer.name = name;
    peer.tile.setName(name);
    if (peer.screenTile) peer.screenTile.setName(name);
  });
  socket.on('peer-media', ({ id, media }) => {
    const peer = state.peers.get(id);
    if (!peer) return;
    peer.media = media;
    setFlags(peer.tile, media);
  });

  // ---------- Entrar / sair ----------
  async function join(channel) {
    if (state.channel === channel) return;
    if (state.channel) leave(true);
    await ensureMicDeferred();
    const res = await new Promise((r) => socket.emit('join', { channel }, r));
    if (res.error) { toast(res.error); return; }
    state.channel = channel;
    $('#channel-title').textContent = '🔊 ' + channel;
    $('#empty').hidden = true;
    $('#controls').hidden = false;
    $('#chat-input').disabled = false;
    $('#chat-input').placeholder = `Mensagem em #${channel}`;
    renderChannels(presence);

    selfTile = makeTile({ name: state.me.name + ' (você)', mirror: true, muted: true });
    refreshSelf();
    if (state.micTrack) {
      watchSpeaking(selfTile, new MediaStream([state.micTrack]), () => state.micTrack && state.micTrack.enabled);
    }
    res.peers.forEach(createPeer);
    $('#messages').textContent = '';
    res.history.forEach(addMessage);
    updateControls();
    emitMedia();
  }

  // O microfone precisa existir antes de criar a tela própria; o tile é criado depois.
  async function ensureMicDeferred() {
    if (state.micTrack) return;
    try {
      const s = await getMicStream();
      state.micTrack = s.getAudioTracks()[0];
      state.micTrack.enabled = state.micWanted && !state.deaf;
      localCam.addTrack(state.micTrack);
    } catch {
      toast('Sem microfone: você poderá ouvir, mas não falar.');
    }
  }

  function leave(silent) {
    stopCam();
    stopScreen();
    for (const id of [...state.peers.keys()]) closePeer(id);
    if (selfTile) { removeTile(selfTile.screen); removeTile(selfTile); selfTile = null; }
    grid.classList.remove('has-focus');
    socket.emit('leave');
    state.channel = null;
    if (silent) return;
    $('#channel-title').textContent = 'Escolha um canal';
    $('#empty').hidden = false;
    $('#controls').hidden = true;
    $('#chat-input').disabled = true;
    $('#chat-input').placeholder = 'Entre em um canal para conversar';
    $('#messages').textContent = '';
    renderChannels(presence);
  }

  // ---------- Controles ----------
  const btn = { mic: $('#btn-mic'), deaf: $('#btn-deaf'), cam: $('#btn-cam'), screen: $('#btn-screen') };
  function updateControls() {
    const micOn = Boolean(state.micTrack && state.micTrack.enabled);
    btn.mic.classList.toggle('off', !micOn);
    btn.deaf.classList.toggle('off', state.deaf);
    btn.cam.classList.toggle('on', Boolean(state.camTrack));
    btn.screen.classList.toggle('on', state.screenTracks.length > 0);
  }

  async function toggleMic() {
    if (state.deaf) return;
    if (!state.micTrack) {
      await ensureMic();
      if (!state.micTrack) return;
    } else {
      state.micWanted = !state.micWanted;
      state.micTrack.enabled = state.micWanted;
    }
    updateControls();
    emitMedia();
  }
  function toggleDeaf() {
    state.deaf = !state.deaf;
    if (state.micTrack) state.micTrack.enabled = state.micWanted && !state.deaf;
    for (const p of state.peers.values()) {
      p.tile.video.muted = state.deaf;
      if (p.screenTile) p.screenTile.video.muted = state.deaf;
    }
    updateControls();
    emitMedia();
  }

  btn.mic.addEventListener('click', toggleMic);
  btn.deaf.addEventListener('click', toggleDeaf);
  btn.cam.addEventListener('click', toggleCam);
  btn.screen.addEventListener('click', toggleScreen);
  $('#btn-leave').addEventListener('click', () => leave(false));

  document.addEventListener('keydown', (e) => {
    if (!state.channel || e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    const k = e.key.toLowerCase();
    if (k === 'm') toggleMic();
    else if (k === 'd') toggleDeaf();
    else if (k === 'v') toggleCam();
    else if (k === 's') toggleScreen();
  });

  // ---------- Chat ----------
  const messages = $('#messages');
  function pushItem(li) {
    const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    messages.append(li);
    if (nearBottom) messages.scrollTop = messages.scrollHeight;
  }
  function addMessage({ from, text, at }) {
    const li = document.createElement('li');
    li.className = 'msg';
    const head = document.createElement('div');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = from;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    head.append(who, when);
    const body = document.createElement('div');
    body.className = 'text';
    body.textContent = text;
    li.append(head, body);
    pushItem(li);
  }
  function addSystem(text) {
    const li = document.createElement('li');
    li.className = 'msg system';
    li.textContent = text;
    pushItem(li);
  }
  socket.on('chat', addMessage);
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat', { text });
    input.value = '';
  });

  // ---------- Celular ----------
  $('#toggle-sidebar').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
  $('#toggle-chat').addEventListener('click', () => $('#chat').classList.toggle('open'));

  // ---------- Janelas ----------
  let inviteTimer = null;
  function openModal(el) { el.hidden = false; }
  function closeModal(el) {
    el.hidden = true;
    if (el.id === 'invite') { clearInterval(inviteTimer); inviteTimer = null; }
  }
  document.querySelectorAll('.modal').forEach((m) => {
    // O seletor de tela só fecha pelos botões, para não perder a escolha sem querer.
    m.addEventListener('mousedown', (e) => { if (e.target === m && m.id !== 'picker') closeModal(m); });
    m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(m)));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal')].find((m) => !m.hidden);
    if (!open) return;
    if (open.id === 'picker') cancelPicker();
    else closeModal(open);
  });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    toast('Copiado!');
  }

  // ---------- Convidar (endereços ao vivo) ----------
  const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  const isSecureUrl = (u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u);
  let inviteSnapshot = '';

  async function refreshInvite() {
    if (!state.me) return;
    let info = null;
    try {
      const r = await fetch(`/server-info?id=${encodeURIComponent(state.me.id)}`);
      if (r.ok) info = await r.json();
    } catch { /* offline: mantém a lista atual */ }

    const rows = [];
    const origin = location.origin;
    const local = isLocalHost(location.hostname);
    rows.push({
      title: local ? 'Neste computador (só funciona aqui)' : 'Endereço que você está usando',
      url: origin,
      tag: local ? '' : 'recomendado',
      copy: !local,
    });
    for (const a of (info && info.addresses) || []) {
      if (a.url === origin) continue;
      rows.push({ title: `${a.label} · ${a.iface}`, url: a.url, tag: '', copy: true });
    }

    const snapshot = JSON.stringify(rows) + (info ? info.online : '');
    if (snapshot !== inviteSnapshot) {
      inviteSnapshot = snapshot;
      const list = $('#invite-list');
      list.textContent = '';
      for (const r of rows) {
        const li = document.createElement('li');
        li.className = 'addr';
        const what = document.createElement('div');
        what.className = 'what';
        const b = document.createElement('b');
        b.textContent = r.title;
        if (r.tag) {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = r.tag;
          b.append(tag);
        }
        const code = document.createElement('code');
        code.textContent = r.url;
        what.append(b, code);
        li.append(what);
        if (r.copy) {
          const c = document.createElement('button');
          c.className = 'btn';
          c.textContent = 'Copiar';
          c.addEventListener('click', () => copyText(r.url));
          li.append(c);
        }
        list.append(li);
      }
    }

    const hasPlain = rows.some((r) => r.copy && !isSecureUrl(r.url));
    const hints = [];
    if (info && !info.addresses.length) hints.push('Nenhuma rede encontrada. Conecte-se ao Wi-Fi, cabo ou a uma VPN.');
    if (hasPlain) {
      hints.push(
        'Endereços http:// funcionam no app LiveApp. No navegador, microfone e câmera exigem HTTPS: ' +
        'para amigos de fora, rode "cloudflared tunnel --url http://localhost:' + (info ? info.port : 3000) + '" e mande o link https.'
      );
    }
    $('#invite-hint').textContent = hints.join(' ');
  }

  function openInvite() {
    if (!state.me) return;
    inviteSnapshot = '';
    openModal($('#invite'));
    refreshInvite();
    clearInterval(inviteTimer);
    inviteTimer = setInterval(refreshInvite, 4000);
  }
  $('#btn-invite').addEventListener('click', openInvite);
  window.addEventListener('liveapp:open-invite', openInvite);

  // No app de desktop de quem hospeda, mostra o convite uma vez após o primeiro login.
  function maybeAutoInvite() {
    if (!window.desktop || !isLocalHost(location.hostname) || store.get('liveapp.inviteShown')) return;
    store.set('liveapp.inviteShown', '1');
    setTimeout(openInvite, 400);
  }

  // ---------- Configurações ----------
  const setEl = {
    name: $('#set-name'), mic: $('#set-mic'), spk: $('#set-spk'), cam: $('#set-cam'), vol: $('#set-vol'),
    ns: $('#set-ns'), ec: $('#set-ec'), agc: $('#set-agc'), res: $('#set-res'), fps: $('#set-fps'),
    bitrate: $('#set-bitrate'), sysaudio: $('#set-sysaudio'), accent: $('#set-accent'),
  };

  function selectTab(name) {
    document.querySelectorAll('#settings-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('#settings [data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  }
  document.querySelectorAll('#settings-tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  async function fillDevices() {
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* sem permissão */ }
    const fill = (select, kind, current, noun) => {
      select.textContent = '';
      const def = new Option('Padrão do sistema', '');
      select.append(def);
      devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .forEach((d, i) => select.append(new Option(d.label || `${noun} ${i + 1}`, d.deviceId)));
      select.value = [...select.options].some((o) => o.value === current) ? current : '';
    };
    fill(setEl.mic, 'audioinput', settings.mic, 'Microfone');
    fill(setEl.spk, 'audiooutput', settings.spk, 'Saída');
    fill(setEl.cam, 'videoinput', settings.cam, 'Câmera');
    setEl.spk.disabled = typeof HTMLMediaElement.prototype.setSinkId !== 'function';
  }

  async function openSettings() {
    setEl.name.value = state.me ? state.me.name : '';
    setEl.vol.value = settings.vol;
    for (const k of ['ns', 'ec', 'agc', 'sysaudio']) setEl[k].checked = Boolean(settings[k]);
    for (const k of ['res', 'fps', 'bitrate']) setEl[k].value = String(settings[k]);
    setEl.accent.value = settings.accent || (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5865f2');
    $('#set-server').value = location.origin;
    const host = window.desktop && isLocalHost(location.hostname);
    $('#leave-server-hint').textContent = window.desktop
      ? (host ? 'Você hospeda este servidor: sair o desliga para todos e volta para a tela de escolha.'
              : 'Volta para a tela de escolha de servidor do app.')
      : 'Você será desconectado e volta para a tela de entrada.';
    $('#set-server-meta').textContent = '';
    selectTab('profile');
    openModal($('#settings'));
    fillDevices();
    try {
      const r = await fetch(`/server-info?id=${encodeURIComponent(state.me.id)}`);
      if (r.ok) {
        const info = await r.json();
        $('#set-server-meta').textContent = `${info.name} · ${info.online} ${info.online === 1 ? 'pessoa conectada' : 'pessoas conectadas'}`;
      }
    } catch { /* ignora */ }
  }
  $('#btn-settings').addEventListener('click', openSettings);

  // Troca o microfone sem derrubar a chamada.
  async function switchMic() {
    const old = state.micTrack;
    if (!old) return;
    let stream;
    try { stream = await getMicStream(); } catch { toast('Não consegui trocar o microfone.'); return; }
    const next = stream.getAudioTracks()[0];
    next.enabled = old.enabled;
    localCam.removeTrack(old);
    localCam.addTrack(next);
    for (const peer of state.peers.values()) {
      const sender = peer.senders.get(old);
      peer.senders.delete(old);
      if (sender) {
        sender.replaceTrack(next).catch(() => {});
        peer.senders.set(next, sender);
      }
    }
    old.stop();
    state.micTrack = next;
    if (selfTile) {
      speakers.delete(selfTile);
      selfTile.analyser = null;
      watchSpeaking(selfTile, new MediaStream([next]), () => state.micTrack && state.micTrack.enabled);
    }
  }

  setEl.mic.addEventListener('change', () => { settings.mic = setEl.mic.value; saveSettings(); switchMic(); });
  setEl.spk.addEventListener('change', () => { settings.spk = setEl.spk.value; saveSettings(); applyOutputAll(); });
  setEl.cam.addEventListener('change', async () => {
    settings.cam = setEl.cam.value;
    saveSettings();
    if (state.camTrack) { stopCam(); await toggleCam(); }
  });
  setEl.vol.addEventListener('input', () => { settings.vol = Number(setEl.vol.value); saveSettings(); applyOutputAll(); });
  for (const k of ['ns', 'ec', 'agc']) {
    setEl[k].addEventListener('change', async () => {
      settings[k] = setEl[k].checked;
      saveSettings();
      if (!state.micTrack) return;
      try {
        await state.micTrack.applyConstraints({
          echoCancellation: settings.ec, noiseSuppression: settings.ns, autoGainControl: settings.agc,
        });
      } catch { switchMic(); }
    });
  }
  for (const k of ['res', 'fps', 'bitrate']) {
    setEl[k].addEventListener('change', () => { settings[k] = setEl[k].value; saveSettings(); });
  }
  setEl.sysaudio.addEventListener('change', () => { settings.sysaudio = setEl.sysaudio.checked; saveSettings(); });
  setEl.accent.addEventListener('input', () => { settings.accent = setEl.accent.value; saveSettings(); applyAccent(); });
  $('#set-accent-reset').addEventListener('click', () => {
    settings.accent = '';
    saveSettings();
    applyAccent();
    setEl.accent.value = (brand.colors && brand.colors.accent) || '#5865f2';
  });

  $('#set-name-save').addEventListener('click', () => {
    const name = setEl.name.value.trim();
    if (!name) return;
    socket.emit('rename', { name }, (res) => {
      if (res.error) { toast(res.error); return; }
      state.me.name = res.name;
      store.set('liveapp.name', res.name);
      $('#me-name').textContent = res.name;
      if (selfTile) {
        selfTile.setName(res.name + ' (você)');
        if (selfTile.screen) selfTile.screen.setName(res.name);
      }
      toast('Nome atualizado.');
    });
  });

  $('#set-server-copy').addEventListener('click', () => copyText(location.origin));
  $('#btn-leave-server').addEventListener('click', () => {
    const hosting = window.desktop && isLocalHost(location.hostname);
    const ask = hosting
      ? 'Você está hospedando este servidor. Sair vai desligá-lo para todos. Continuar?'
      : 'Sair deste servidor?';
    if (!confirm(ask)) return;
    leave(true);
    if (window.desktop && window.desktop.leaveServer) { window.desktop.leaveServer(); return; }
    socket.disconnect();
    location.reload();
  });

  // ---------- Escolher tela ou aplicativo (app de desktop) ----------
  let pickerReq = null;
  let pickerTab = 'screen';
  let pickerSel = null;

  function renderPicker() {
    const grid = $('#picker-grid');
    grid.textContent = '';
    document.querySelectorAll('#picker [data-ptab]').forEach((b) => b.classList.toggle('active', b.dataset.ptab === pickerTab));
    const items = pickerReq.sources.filter((s) => s.type === pickerTab);
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'picker-empty';
      p.textContent = pickerTab === 'screen' ? 'Nenhuma tela encontrada.' : 'Nenhum aplicativo aberto encontrado.';
      grid.append(p);
    }
    for (const s of items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'source' + (pickerSel === s.id ? ' selected' : '');
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.style.backgroundImage = `url("${s.thumb}")`;
      const meta = document.createElement('div');
      meta.className = 'meta';
      if (s.icon) {
        const img = document.createElement('img');
        img.src = s.icon;
        img.alt = '';
        meta.append(img);
      }
      const name = document.createElement('span');
      name.textContent = s.name;
      name.title = s.name;
      meta.append(name);
      card.append(thumb, meta);
      card.addEventListener('click', () => {
        pickerSel = s.id;
        $('#picker-go').disabled = false;
        grid.querySelectorAll('.source').forEach((c) => c.classList.toggle('selected', c === card));
      });
      card.addEventListener('dblclick', confirmPicker);
      grid.append(card);
    }
  }

  function showPicker(req) {
    if (pickerReq) window.desktop.cancelPick(pickerReq.reqId);
    pickerReq = req;
    pickerSel = null;
    pickerTab = req.sources.some((s) => s.type === 'screen') ? 'screen' : 'window';
    $('#picker-go').disabled = true;
    $('#picker-audio-wrap').hidden = !req.audioRequested;
    $('#picker-audio').checked = Boolean(settings.sysaudio);
    renderPicker();
    openModal($('#picker'));
  }
  function confirmPicker() {
    if (!pickerReq || !pickerSel) return;
    window.desktop.pickSource(pickerReq.reqId, pickerSel, $('#picker-audio').checked);
    pickerReq = null;
    closeModal($('#picker'));
  }
  function cancelPicker() {
    if (pickerReq) window.desktop.cancelPick(pickerReq.reqId);
    pickerReq = null;
    closeModal($('#picker'));
  }
  document.querySelectorAll('#picker [data-ptab]').forEach((b) => b.addEventListener('click', () => {
    if (!pickerReq) return;
    pickerTab = b.dataset.ptab;
    pickerSel = null;
    $('#picker-go').disabled = true;
    renderPicker();
  }));
  $('#picker-go').addEventListener('click', confirmPicker);
  $('#picker-cancel').addEventListener('click', cancelPicker);
  $('#picker-x').addEventListener('click', cancelPicker);
  if (window.desktop && window.desktop.onPickSources) window.desktop.onPickSources(showPicker);

  // ---------- Reconexão ----------
  let wasConnected = false;
  socket.on('connect', async () => {
    if (!wasConnected) { wasConnected = true; return; }
    if (!state.me) return;
    const channel = state.channel;
    const res = await login(state.me.name, state.code);
    if (res.error) { toast(res.error); return; }
    if (channel) {
      leave(true);
      await join(channel);
    }
    toast('Reconectado.');
  });
  socket.on('disconnect', () => toast('Conexão perdida. Tentando reconectar…'));
})();
