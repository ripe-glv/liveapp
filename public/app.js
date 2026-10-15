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
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
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
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
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
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
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
        p.encodings[0].maxBitrate = 3_000_000;
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
    return { el, video, flags, analyser: null, stream: null };
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
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
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
    if (!state.channel || e.target.matches('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
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
