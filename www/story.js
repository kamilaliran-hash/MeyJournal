/* MeyJournal — Story mode: animated slideshow with music, and video export.
 * Music is synthesized live with Web Audio (royalty-free, works offline),
 * or the user can pick their own song (stored on-device per trip).
 */
'use strict';

/* ---------------- Music engine ---------------- */
const MOODS = {
  calm: { label: 'Calm', sub: 'Soft piano pads', bpm: 70, prog: [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65]], arp: 'slow', drums: false },
  upbeat: { label: 'Upbeat', sub: 'Bright & happy', bpm: 112, prog: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], arp: 'eighth', drums: 'pop' },
  adventure: { label: 'Adventure', sub: 'Epic road trip', bpm: 92, prog: [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]], arp: 'sixteenth', drums: 'big' },
  tropical: { label: 'Tropical', sub: 'Island vibes', bpm: 100, prog: [[62, 66, 69], [59, 62, 66], [55, 59, 62], [57, 61, 64]], arp: 'island', drums: 'shaker' }
};
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);

const Music = {
  ctx: null, master: null, recDest: null, timer: null, nextT: 0, step: 0, mood: null, el: null, src: null, noise: null,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.0001;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp); comp.connect(this.ctx.destination);
      this.out = comp;
      const len = this.ctx.sampleRate * 1, buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  recordStream() {
    if (!this.ensure()) return null;
    if (!this.recDest) { this.recDest = this.ctx.createMediaStreamDestination(); this.out.connect(this.recDest); }
    return this.recDest.stream;
  },
  async play(kind, customBlob) {
    this.stop(true);
    if (kind === 'none' || !this.ensure()) return;
    const c = this.ctx, now = c.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0.0001, now);
    this.master.gain.exponentialRampToValueAtTime(0.9, now + 1.5);
    if (kind === 'custom' && customBlob) {
      this.el = new Audio(URL.createObjectURL(customBlob)); this.el.loop = true;
      this.src = c.createMediaElementSource(this.el); this.src.connect(this.master);
      try { await this.el.play(); } catch (e) { toast('Could not play that song'); }
      return;
    }
    this.mood = MOODS[kind] || MOODS.calm; this.step = 0; this.nextT = now + 0.1;
    this.timer = setInterval(() => this.schedule(), 60);
    this.schedule();
  },
  fadeOut(sec = 2) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), now);
    this.master.gain.exponentialRampToValueAtTime(0.0001, now + sec);
  },
  pause() { if (this.ctx) this.ctx.suspend(); if (this.el) this.el.pause(); },
  resume() { if (this.ctx) this.ctx.resume(); if (this.el) this.el.play().catch(() => { }); },
  stop(immediate) {
    clearInterval(this.timer); this.timer = null;
    if (this.el) { this.el.pause(); URL.revokeObjectURL(this.el.src); this.el = null; }
    if (this.src) { try { this.src.disconnect(); } catch (e) { } this.src = null; }
    if (this.ctx && immediate) { this.master.gain.cancelScheduledValues(this.ctx.currentTime); this.master.gain.setValueAtTime(0.0001, this.ctx.currentTime); }
  },
  schedule() {
    const c = this.ctx, M = this.mood, spb = 60 / M.bpm, s16 = spb / 4;
    while (this.nextT < c.currentTime + 0.25) {
      const st = this.step, t = this.nextT;
      const bar = Math.floor(st / 16), chord = M.prog[bar % M.prog.length], pos = st % 16;
      if (pos === 0) { this.pad(chord, t, spb * 4); this.bass(chord[0] - 24, t, spb * 1.6); }
      if (pos === 8 && M.drums) this.bass(chord[0] - 24, t, spb * 1.2);
      // arpeggio
      const arpNote = i => chord[i % chord.length] + 12 * (1 + Math.floor(i / chord.length) % 2);
      if (M.arp === 'slow' && pos % 4 === 0) this.pluck(arpNote(pos / 4 + bar), t, spb * 1.8, 0.10);
      if (M.arp === 'eighth' && pos % 2 === 0) this.pluck(arpNote(pos / 2), t, spb * 0.6, 0.08);
      if (M.arp === 'sixteenth' && [0, 3, 6, 8, 10, 11, 14].includes(pos)) this.pluck(arpNote(pos), t, spb * 0.45, 0.07);
      if (M.arp === 'island' && [0, 3, 6, 10, 12].includes(pos)) this.pluck(arpNote(pos + bar) + (pos === 12 ? 12 : 0), t, spb * 0.5, 0.09, 'sine');
      // drums
      if (M.drums === 'pop') { if (pos % 4 === 0) this.kick(t, 0.5); if (pos % 4 === 2) this.hat(t, 0.05); if (pos === 4 || pos === 12) this.snare(t, 0.18); }
      if (M.drums === 'big') { if (pos === 0 || pos === 6 || pos === 10) this.kick(t, 0.6); if (pos === 4 || pos === 12) this.snare(t, 0.22); if (pos % 2 === 1) this.hat(t, 0.025); }
      if (M.drums === 'shaker') { if (pos === 0 || pos === 10) this.kick(t, 0.4); if (pos % 2 === 0) this.hat(t, pos % 4 ? 0.06 : 0.03); if (pos === 6 || pos === 14) this.snare(t, 0.08); }
      this.nextT += s16; this.step++;
    }
  },
  env(g, t, a, peak, d) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + d); },
  pad(chord, t, dur) {
    const c = this.ctx, f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 0.4;
    f.connect(g); g.connect(this.master);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.8); g.gain.setValueAtTime(0.05, t + dur - 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.4);
    chord.forEach(n => [-6, 6].forEach(det => { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midiHz(n); o.detune.value = det; o.connect(f); o.start(t); o.stop(t + dur + 0.5); }));
  },
  pluck(n, t, dur, vol, type = 'triangle') {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = midiHz(n); o.connect(g); g.connect(this.master);
    this.env(g, t, 0.01, vol, dur); o.start(t); o.stop(t + dur + 0.05);
  },
  bass(n, t, dur) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = midiHz(n); o.connect(g); g.connect(this.master);
    this.env(g, t, 0.02, 0.22, dur); o.start(t); o.stop(t + dur + 0.05);
  },
  kick(t, vol) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    o.connect(g); g.connect(this.master); this.env(g, t, 0.005, vol, 0.3); o.start(t); o.stop(t + 0.35);
  },
  noiseHit(t, vol, freq, dur, type) {
    const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; f.type = type; f.frequency.value = freq;
    s.connect(f); f.connect(g); g.connect(this.master); this.env(g, t, 0.003, vol, dur); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  },
  hat(t, vol) { this.noiseHit(t, vol, 7000, 0.06, 'highpass'); },
  snare(t, vol) { this.noiseHit(t, vol, 1800, 0.18, 'bandpass'); }
};

/* ---------------- Story timeline ---------------- */
const SCENE = { title: 4.2, map: 4.5, chapter: 4.2, photo: 3.0, outro: 4.5, fade: 0.8 };
function buildScenes(trip) {
  const sc = [];
  const all = trip.chapters.flatMap(c => c.photoIds);
  const cover = trip.coverId && S.photos.has(trip.coverId) ? trip.coverId : all[0];
  sc.push({ type: 'title', photo: cover, dur: SCENE.title });
  if (trip.chapters.filter(c => c.lat != null).length > 1) sc.push({ type: 'map', dur: SCENE.map });
  // keep stories watchable: at most ~70 photos, spread fairly across stops
  const per = Math.max(3, Math.floor(70 / Math.max(1, trip.chapters.length)));
  trip.chapters.forEach((ch, ci) => {
    let ids = ch.photoIds.filter(id => S.photos.has(id));
    if (!ids.length) return;
    if (ids.length > per) { const step = ids.length / per; ids = Array.from({ length: per }, (_, i) => ids[Math.floor(i * step)]); }
    sc.push({ type: 'chapter', ch, ci, photo: ids[0], dur: SCENE.chapter });
    ids.slice(1).forEach((id, k) => sc.push({ type: 'photo', ch, photo: id, dur: SCENE.photo, k }));
  });
  sc.push({ type: 'outro', photo: all[all.length - 1] || cover, dur: SCENE.outro });
  let t = 0; sc.forEach(s => { s.t0 = t; t += s.dur; });
  return { scenes: sc, total: t };
}

/* ---------------- Player ---------------- */
const Story = (() => {
  let root, cv, ctx, data, raf, t0 = 0, elapsed = 0, playing = false, rec = null, recChunks = [], bitmaps = new Map(), musicKind = 'calm', customMusic = null;

  const isOpen = () => !!root;

  async function bitmap(id) {
    if (!id) return null;
    if (bitmaps.has(id)) return bitmaps.get(id);
    const p = S.photos.get(id); if (!p) return null;
    const pr = createImageBitmap(p.blob).catch(() => null);
    bitmaps.set(id, pr); return pr;
  }
  const ready = new Map();
  function preload(idx) {
    for (let i = Math.max(0, idx - 1); i < Math.min(data.scenes.length, idx + 4); i++) {
      const id = data.scenes[i].photo;
      if (id && !ready.has(id)) bitmap(id).then(b => ready.set(id, b));
    }
    // release far-behind images to keep memory low on phones
    ready.forEach((b, id) => {
      const idxOf = data.scenes.findIndex(s => s.photo === id);
      if (idxOf >= 0 && idxOf < idx - 2 && b) { b.close && b.close(); ready.delete(id); bitmaps.delete(id); }
    });
  }

  function sizeCanvas() {
    const portrait = window.innerHeight > window.innerWidth;
    cv.width = portrait ? 720 : 1280; cv.height = portrait ? 1280 : 720;
  }

  function kenBurns(img, W, H, p, k) {
    if (!img) { ctx.fillStyle = '#0b2a33'; ctx.fillRect(0, 0, W, H); return; }
    const z = 1.04 + 0.1 * p, dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]], [dx, dy] = dirs[k % dirs.length];
    const s = Math.max(W / img.width, H / img.height) * z, w = img.width * s, h = img.height * s;
    const ox = (W - w) / 2 + dx * (p - 0.5) * (w - W) * 0.8, oy = (H - h) / 2 + dy * (p - 0.5) * (h - H) * 0.8;
    ctx.drawImage(img, ox, oy, w, h);
  }
  function shade(W, H, from = 0.45, a = 0.75) {
    const g = ctx.createLinearGradient(0, H * from, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${a})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  const ease = x => x < 0 ? 0 : x > 1 ? 1 : 1 - Math.pow(1 - x, 3);

  function drawScene(sc, local, alpha) {
    const W = cv.width, H = cv.height, u = Math.min(W, H) / 720, p = local / sc.dur, T = THEMES.minimal;
    const m = 48 * u, font = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', serif = 'Georgia, "DejaVu Serif", serif';
    ctx.save(); ctx.globalAlpha = alpha;
    const img = sc.photo ? ready.get(sc.photo) : null;
    const textIn = d => ease((local - d) / 0.9);
    if (sc.type === 'title') {
      kenBurns(img, W, H, p, 4); shade(W, H, 0.3, 0.8);
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = alpha * textIn(0.3); ctx.font = `bold ${15 * u}px ${font}`; ctx.fillStyle = '#FF8A65';
      ctx.fillText(`A ${(S.trip.tripType || 'travel').toUpperCase()} STORY${S.trip.travellers ? ' · WITH ' + S.trip.travellers.toUpperCase() : ''}`, m, H - m - 120 * u);
      ctx.globalAlpha = alpha * textIn(0.6); ctx.fillStyle = '#fff'; ctx.font = `bold ${58 * u}px ${serif}`;
      const lines = wrap(ctx, S.trip.title || 'Our trip', W - 2 * m).slice(0, 2);
      lines.forEach((l, i) => ctx.fillText(l, m, H - m - 52 * u - (lines.length - 1 - i) * 62 * u));
      ctx.globalAlpha = alpha * textIn(1.0); ctx.font = `${20 * u}px ${font}`; ctx.fillText(subOf(S.trip), m, H - m);
    } else if (sc.type === 'map') {
      ctx.fillStyle = '#0F2D36'; ctx.fillRect(0, 0, W, H);
      const st = tripStats(S.trip), Tn = { ...THEMES.bold, map: '#163C47' };
      ctx.fillStyle = '#FF8A65'; ctx.font = `bold ${15 * u}px ${font}`; ctx.fillText('THE ROUTE', m, m + 10 * u);
      ctx.fillStyle = '#fff'; ctx.font = `bold ${30 * u}px ${serif}`;
      ctx.fillText(`${st.days} days · ${st.places} stops · ${st.km.toLocaleString()} km`, m, m + 52 * u);
      ctx.globalAlpha = alpha * ease(local / 1.2);
      drawRouteMap(ctx, m, m + 80 * u, W - 2 * m, H - 2 * m - 80 * u, S.trip, Tn, 1.6 * u);
    } else if (sc.type === 'chapter') {
      kenBurns(img, W, H, p, sc.ci); shade(W, H, 0.2, 0.85);
      const ch = sc.ch; let y = H - m;
      ctx.font = `${19 * u}px ${font}`;
      const cap = wrap(ctx, ch.caption || '', W - 2 * m).slice(0, 4);
      y -= cap.length * 28 * u;
      ctx.globalAlpha = alpha * textIn(0.3); ctx.fillStyle = '#FF8A65'; ctx.font = `bold ${15 * u}px ${font}`;
      ctx.fillText(`STOP ${sc.ci + 1}  ·  DAY ${ch.day}  ·  ${fmtDate(ch.start).toUpperCase()}`, m, y - 74 * u);
      ctx.globalAlpha = alpha * textIn(0.5); ctx.fillStyle = '#fff'; ctx.font = `bold ${46 * u}px ${serif}`;
      ctx.fillText(ch.title || '', m, y - 20 * u);
      ctx.globalAlpha = alpha * textIn(1.0); ctx.font = `${19 * u}px ${font}`; ctx.fillStyle = 'rgba(255,255,255,.92)';
      cap.forEach((l, i) => ctx.fillText(l, m, y + 14 * u + i * 28 * u));
    } else if (sc.type === 'photo') {
      kenBurns(img, W, H, p, sc.k + 1); shade(W, H, 0.75, 0.5);
      ctx.globalAlpha = alpha * 0.9; ctx.fillStyle = '#fff'; ctx.font = `600 ${16 * u}px ${font}`;
      ctx.fillText(`${sc.ch.title}  ·  Day ${sc.ch.day}`, m, H - m * 0.7);
    } else if (sc.type === 'outro') {
      kenBurns(img, W, H, p, 2); ctx.fillStyle = 'rgba(5,22,27,.62)'; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.globalAlpha = alpha * textIn(0.3); ctx.font = `italic ${44 * u}px ${serif}`; ctx.fillText('Until the next adventure', W / 2, H / 2);
      const st = tripStats(S.trip);
      ctx.globalAlpha = alpha * textIn(0.8); ctx.font = `${18 * u}px ${font}`;
      ctx.fillText(`${st.photos} photos · ${st.places} stops${st.km ? ' · ' + st.km.toLocaleString() + ' km' : ''}`, W / 2, H / 2 + 44 * u);
      if (S.trip.travellers) { ctx.font = `italic ${20 * u}px ${serif}`; ctx.fillText(`with ${S.trip.travellers}`, W / 2, H / 2 + 80 * u); }
      ctx.globalAlpha = alpha * textIn(1.4) * 0.8; ctx.font = `600 ${14 * u}px ${font}`; ctx.fillText('MeyJournal', W / 2, H - m);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  function frame(now) {
    if (!root) return;
    if (playing) elapsed = (now - t0) / 1000;
    const total = data.total;
    if (elapsed >= total) { elapsed = total; if (playing) finish(); }
    const sc = data.scenes, i = Math.max(0, sc.findIndex(s => elapsed < s.t0 + s.dur)), cur = sc[i === -1 ? sc.length - 1 : i];
    preload(i);
    const local = elapsed - cur.t0;
    ctx.fillStyle = '#05161b'; ctx.fillRect(0, 0, cv.width, cv.height);
    const prev = sc[i - 1];
    if (prev && local < SCENE.fade) { drawScene(prev, prev.dur + local, 1); drawScene(cur, local, ease(local / SCENE.fade)); }
    else drawScene(cur, local, 1);
    root.querySelector('.bar2 i').style.width = (elapsed / total * 100) + '%';
    raf = requestAnimationFrame(frame);
  }

  function finish() {
    playing = false; Music.fadeOut(2.5); setBtn();
    if (rec && rec.state === 'recording') setTimeout(() => rec && rec.state === 'recording' && rec.stop(), 1200);
  }
  function setBtn() { const b = root && root.querySelector('[data-s=pp]'); if (b) b.textContent = playing ? '❚❚ Pause' : (elapsed >= data.total ? '↺ Replay' : '▶ Play'); }

  async function loadCustom() {
    try { const r = await DB.get('music', S.trip.id); customMusic = r ? r.blob : null; return r; } catch (e) { return null; }
  }
  async function startMusic() { await Music.play(musicKind, customMusic); }

  function play() {
    if (elapsed >= data.total) elapsed = 0;
    t0 = performance.now() - elapsed * 1000; playing = true;
    if (elapsed < 0.1) startMusic(); else Music.resume();
    setBtn();
  }
  function pause() { playing = false; Music.pause(); setBtn(); }

  function musicOptions() {
    const opts = Object.entries(MOODS).map(([k, v]) => `<option value="${k}" ${musicKind === k ? 'selected' : ''}>♪ ${v.label}</option>`).join('');
    return `${opts}<option value="custom" ${musicKind === 'custom' ? 'selected' : ''}>♪ ${customMusic ? 'My song' : 'Choose my own song…'}</option><option value="none" ${musicKind === 'none' ? 'selected' : ''}>No music</option>`;
  }

  async function open(autoplay = true) {
    if (!S.trip || !S.photos.size) return;
    await saveTrip(true);
    musicKind = S.trip.music || 'calm';
    await loadCustom();
    if (musicKind === 'custom' && !customMusic) musicKind = 'calm';
    data = buildScenes(S.trip); elapsed = 0; ready.clear(); bitmaps.clear();
    root = document.createElement('div'); root.className = 'story';
    root.innerHTML = `<button class="x" data-s="close" aria-label="Close">✕</button>
      <canvas></canvas><div class="bar2"><i></i></div>
      <div class="ctrls">
        <button class="btn primary" data-s="pp">▶ Play</button>
        <select data-s="music" aria-label="Music">${musicOptions()}</select>
        <span class="grow"></span>
        <span class="sub" style="color:#9fb3b8">${Math.round(data.total)}s</span>
        <button class="btn ghost" data-s="video" title="Save the story as a video">⤓ Save video</button>
      </div>`;
    document.body.appendChild(root);
    cv = root.querySelector('canvas'); ctx = cv.getContext('2d'); sizeCanvas();
    // preload first scenes before starting so the opening isn't blank
    await Promise.all(data.scenes.slice(0, 3).map(s => s.photo && bitmap(s.photo).then(b => ready.set(s.photo, b))));
    root.addEventListener('click', onClick);
    root.querySelector('[data-s=music]').addEventListener('change', onMusic);
    raf = requestAnimationFrame(frame);
    if (autoplay) play(); else setBtn();
  }
  async function onMusic(e) {
    const v = e.target.value;
    if (v === 'custom' && !customMusic) {
      const inp = $('#musicIn');
      inp.onchange = async () => {
        const f = inp.files && inp.files[0]; inp.value = '';
        if (!f) { e.target.value = musicKind; return; }
        if (f.size > 40 * 1024 * 1024) { toast('That song is too large (max 40 MB)'); e.target.value = musicKind; return; }
        await DB.put('music', { tripId: S.trip.id, blob: f, name: f.name });
        customMusic = f; musicKind = 'custom'; S.trip.music = 'custom'; saveTrip();
        e.target.innerHTML = musicOptions(); toast('Song added: ' + f.name);
        if (playing) startMusic();
      };
      inp.click(); return;
    }
    musicKind = v; S.trip.music = v; saveTrip();
    if (playing) startMusic();
  }
  async function onClick(e) {
    const a = e.target.closest('[data-s]'); if (!a) { if (e.target === cv) playing ? pause() : play(); return; }
    const s = a.dataset.s;
    if (s === 'close') close();
    if (s === 'pp') playing ? pause() : play();
    if (s === 'video') recordVideo();
  }

  function pickMime() {
    const c = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));
  }
  function recordVideo() {
    const mime = pickMime();
    if (!mime || !cv.captureStream) { toast('Video saving is not supported on this device'); return; }
    if (rec) return;
    const stream = cv.captureStream(30);
    const aud = musicKind !== 'none' ? Music.recordStream() : null;
    if (aud) aud.getAudioTracks().forEach(t => stream.addTrack(t));
    recChunks = [];
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5e6 });
    rec.ondataavailable = ev => ev.data.size && recChunks.push(ev.data);
    rec.onstop = async () => {
      const badge = root && root.querySelector('.rec'); if (badge) badge.remove();
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(recChunks, { type: mime.split(';')[0] }); rec = null;
      const name = `${(S.trip.title || 'travel-story').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-')}-story.${ext}`;
      await Platform.saveFile(blob, name);
      if (!Platform.cap()) toast('Story video saved');
    };
    // restart from the beginning while recording
    elapsed = 0; playing = false; Music.stop(true);
    const b = document.createElement('div'); b.className = 'rec'; b.textContent = '● REC — keep this screen open';
    root.appendChild(b);
    rec.start(1000);
    play();
  }

  function close() {
    if (rec && rec.state === 'recording') { rec.onstop = null; rec.stop(); rec = null; toast('Recording cancelled'); }
    cancelAnimationFrame(raf); Music.stop(true);
    playing = false;
    ready.forEach(b => b && b.close && b.close()); ready.clear(); bitmaps.clear();
    if (root) root.remove(); root = null;
  }

  /** After upload: "your story is ready" with a music choice (tap = user gesture so audio may start). */
  function offer(n) {
    const cur = S.trip.music && S.trip.music !== 'custom' && S.trip.music !== 'none' ? S.trip.music : 'calm';
    const m = modal(`<h2>✨ Your story is ready</h2>
      <p class="sub" style="line-height:1.5;margin:0">We grouped ${n} new photo${n > 1 ? 's' : ''} into ${S.trip.chapters.length} stop${S.trip.chapters.length > 1 ? 's' : ''} and wrote a caption for each. Pick the music:</p>
      <div class="offer-music">${Object.entries(MOODS).map(([k, v]) => `<button data-m="${k}" class="${k === cur ? 'on' : ''}"><b>♪ ${v.label}</b><small>${v.sub}</small></button>`).join('')}</div>
      <div class="row" style="justify-content:space-between"><button class="btn line" data-a="no">Later</button><button class="btn primary" data-a="play">▶ Play my story</button></div>`);
    let pick = cur;
    m.el.addEventListener('click', e => {
      const mb = e.target.closest('[data-m]');
      if (mb) {
        pick = mb.dataset.m; m.el.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === mb));
        Music.play(pick); setTimeout(() => Music.fadeOut(1), 2200); // short preview
        return;
      }
      const a = e.target.closest('[data-a]');
      if (a || e.target === m.el) {
        m.close(); Music.stop(true);
        S.trip.music = pick; saveTrip();
        if (a && a.dataset.a === 'play') open(true);
      }
    });
  }

  window.addEventListener('resize', () => { if (root) sizeCanvas(); });
  document.addEventListener('keydown', e => { if (!root) return; if (e.key === 'Escape') close(); if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); } });
  return { open, close, offer, isOpen };
})();
window.Story = Story;
