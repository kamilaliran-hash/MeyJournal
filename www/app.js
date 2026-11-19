/* MeyJournal — travel photo book app
 * Runs offline in browser, Electron (Windows) and Capacitor (Android).
 * Storage: IndexedDB. Rendering: <canvas> (same renderer for preview + PDF export).
 */
'use strict';

const MAX_PHOTOS = 1200;
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = t => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const dayKey = t => { const d = new Date(t); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function fmtRange(a, b) {
  const A = new Date(a), B = new Date(b);
  if (dayKey(a) === dayKey(b)) return fmtDate(a);
  if (A.getFullYear() === B.getFullYear() && A.getMonth() === B.getMonth()) return `${A.getDate()}–${B.getDate()} ${MONTHS[B.getMonth()]} ${B.getFullYear()}`;
  if (A.getFullYear() === B.getFullYear()) return `${A.getDate()} ${MONTHS[A.getMonth()]} – ${B.getDate()} ${MONTHS[B.getMonth()]} ${B.getFullYear()}`;
  return `${fmtDate(a)} – ${fmtDate(b)}`;
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const parseYmd = s => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s || ''); return m ? new Date(+m[1], m[2] - 1, +m[3]).getTime() : null; };
const fmtDay = k => { const t = parseYmd(k); const d = new Date(t); return `${DOW[d.getDay()]}, ${fmtDate(t)}`; };
const TRIP_TYPES = ['Holiday', 'Family', 'Honeymoon', 'Friends', 'Solo', 'Business', 'Umrah', 'School trip', 'Road trip', 'Backpacking'];
/** first day of the trip (for "Day n" numbering) */
function tripT0(trip, photos) {
  const s = parseYmd(trip.startDate);
  const first = photos.length ? startOfDay(Math.min(...photos.map(p => p.time))) : null;
  if (s != null && first != null) return Math.min(s, first);
  return s != null ? s : first != null ? first : startOfDay(Date.now());
}
/** every day of the trip: the date range plus any day that has photos */
function tripDays(trip) {
  const set = new Set();
  const a = parseYmd(trip.startDate), b = parseYmd(trip.endDate || trip.startDate);
  if (a != null && b != null) for (let t = a, i = 0; t <= b && i < 120; i++) { set.add(ymd(t)); t = new Date(new Date(t).setDate(new Date(t).getDate() + 1)).getTime(); }
  (trip.chapters || []).forEach(c => c.dayKey && set.add(c.dayKey));
  return [...set].sort();
}
const dayNum = (trip, key) => Math.round((parseYmd(key) - tripT0(trip, [...S.photos.values()])) / 864e5) + 1;
function km(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/* ---------------- Platform (Android / Windows / Web) ---------------- */
const Platform = {
  cap: () => window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform(),
  async saveFile(blob, name) {
    if (Platform.cap()) {
      const { Filesystem, Share } = window.Capacitor.Plugins;
      const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
      let uri;
      try {
        const r = await Filesystem.writeFile({ path: name, data: b64, directory: 'DOCUMENTS', recursive: true });
        uri = r.uri; toast('Saved to Documents/' + name);
      } catch (e) {
        const r = await Filesystem.writeFile({ path: name, data: b64, directory: 'CACHE' });
        uri = r.uri;
      }
      try { await Share.share({ title: name, url: uri, dialogTitle: 'Save or share your photo book' }); } catch (e) { /* user cancelled */ }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
};

/* ---------------- IndexedDB ---------------- */
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('meyjournal', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('trips')) d.createObjectStore('trips', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' }).createIndex('trip', 'tripId');
      if (!d.objectStoreNames.contains('music')) d.createObjectStore('music', { keyPath: 'tripId' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      let out; const rq = fn(s);
      if (rq) rq.onsuccess = () => { out = rq.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  return {
    get: (s, k) => tx(s, 'readonly', st => st.get(k)),
    put: (s, v) => tx(s, 'readwrite', st => st.put(v)),
    del: (s, k) => tx(s, 'readwrite', st => st.delete(k)),
    all: s => tx(s, 'readonly', st => st.getAll()),
    photosOf: id => tx('photos', 'readonly', st => st.index('trip').getAll(id)),
    async deleteTrip(id) {
      const ps = await DB.photosOf(id);
      await tx('photos', 'readwrite', st => { ps.forEach(p => st.delete(p.id)); });
      await DB.del('trips', id);
      try { await DB.del('music', id); } catch (e) { }
    }
  };
})();

/* ---------------- EXIF (JPEG): date, GPS ---------------- */
function readExif(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return {};
  let o = 2;
  while (o < v.byteLength - 4) {
    const m = v.getUint16(o);
    if ((m & 0xFF00) !== 0xFF00) break;
    const len = v.getUint16(o + 2);
    if (m === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) return parseTiff(v, o + 10);
    if (m === 0xFFDA) break;
    o += 2 + len;
  }
  return {};
}
function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
  const ifd = off => {
    const out = {}, base = t + off; if (base + 2 > v.byteLength) return out;
    const n = u16(base);
    for (let i = 0; i < n; i++) { const e = base + 2 + i * 12; if (e + 12 > v.byteLength) break; out[u16(e)] = { type: u16(e + 2), cnt: u32(e + 4), at: e + 8 }; }
    return out;
  };
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const val = en => {
    const size = (SZ[en.type] || 1) * en.cnt, p = size > 4 ? t + u32(en.at) : en.at;
    if (en.type === 2) { let s = ''; for (let i = 0; i < en.cnt; i++) { const c = v.getUint8(p + i); if (!c) break; s += String.fromCharCode(c); } return s; }
    if (en.type === 5) { const a = []; for (let i = 0; i < en.cnt; i++) a.push(u32(p + i * 8) / u32(p + i * 8 + 4)); return a; }
    if (en.type === 3) return u16(p);
    if (en.type === 4) return u32(p);
    return null;
  };
  const parseDate = s => { const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s || ''); return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };
  const res = {};
  const i0 = ifd(u32(t + 4));
  if (i0[0x8769]) { const ex = ifd(val(i0[0x8769])); const d = ex[0x9003] || ex[0x9004]; if (d) res.time = parseDate(val(d)); }
  if (!res.time && i0[0x0132]) res.time = parseDate(val(i0[0x0132]));
  if (i0[0x8825]) {
    const g = ifd(val(i0[0x8825]));
    if (g[2] && g[4]) {
      const la = val(g[2]), lo = val(g[4]);
      let lat = la[0] + la[1] / 60 + la[2] / 3600, lon = lo[0] + lo[1] / 60 + lo[2] / 3600;
      if (g[1] && val(g[1]) === 'S') lat = -lat;
      if (g[3] && val(g[3]) === 'W') lon = -lon;
      if (isFinite(lat) && isFinite(lon) && !(lat === 0 && lon === 0)) { res.lat = lat; res.lon = lon; }
    }
  }
  return res;
}

/* ---------------- Places (offline nearest-city naming) ---------------- */
const CITIES = `Kuala Lumpur|Malaysia|3.139|101.687;Putrajaya|Malaysia|2.926|101.696;Shah Alam|Malaysia|3.073|101.518;Petaling Jaya|Malaysia|3.107|101.607;Genting Highlands|Malaysia|3.423|101.793;Melaka|Malaysia|2.189|102.251;Seremban|Malaysia|2.726|101.938;Port Dickson|Malaysia|2.522|101.796;Johor Bahru|Malaysia|1.492|103.741;Desaru|Malaysia|1.55|104.26;Mersing|Malaysia|2.43|103.84;Tioman|Malaysia|2.79|104.17;Kuantan|Malaysia|3.817|103.326;Cherating|Malaysia|4.13|103.39;Kuala Terengganu|Malaysia|5.329|103.137;Redang|Malaysia|5.78|103.01;Perhentian Islands|Malaysia|5.91|102.74;Kota Bharu|Malaysia|6.125|102.238;Taman Negara|Malaysia|4.38|102.4;Cameron Highlands|Malaysia|4.471|101.377;Ipoh|Malaysia|4.597|101.09;Taiping|Malaysia|4.85|100.74;Pangkor|Malaysia|4.22|100.55;George Town|Malaysia|5.414|100.329;Butterworth|Malaysia|5.399|100.364;Alor Setar|Malaysia|6.121|100.367;Langkawi|Malaysia|6.35|99.8;Kangar|Malaysia|6.44|100.2;Kota Kinabalu|Malaysia|5.98|116.073;Mount Kinabalu|Malaysia|6.075|116.558;Sandakan|Malaysia|5.839|118.117;Semporna|Malaysia|4.48|118.61;Tawau|Malaysia|4.25|117.89;Kuching|Malaysia|1.553|110.359;Miri|Malaysia|4.4|113.99;Sibu|Malaysia|2.29|111.83;Bintulu|Malaysia|3.17|113.04;Mulu|Malaysia|4.05|114.81;Labuan|Malaysia|5.28|115.24;
Singapore|Singapore|1.29|103.85;Bangkok|Thailand|13.756|100.502;Chiang Mai|Thailand|18.788|98.985;Phuket|Thailand|7.88|98.39;Krabi|Thailand|8.09|98.91;Hat Yai|Thailand|7.01|100.47;Koh Samui|Thailand|9.51|100.01;Pattaya|Thailand|12.93|100.88;Jakarta|Indonesia|-6.208|106.846;Bali|Indonesia|-8.65|115.22;Yogyakarta|Indonesia|-7.795|110.369;Bandung|Indonesia|-6.917|107.619;Surabaya|Indonesia|-7.25|112.75;Medan|Indonesia|3.59|98.67;Lombok|Indonesia|-8.65|116.32;Batam|Indonesia|1.13|104.05;Manila|Philippines|14.6|120.98;Cebu|Philippines|10.31|123.89;Boracay|Philippines|11.97|121.92;Palawan|Philippines|9.84|118.74;Ho Chi Minh City|Vietnam|10.823|106.63;Hanoi|Vietnam|21.028|105.854;Da Nang|Vietnam|16.054|108.202;Hoi An|Vietnam|15.88|108.33;Ha Long|Vietnam|20.95|107.08;Phnom Penh|Cambodia|11.556|104.928;Siem Reap|Cambodia|13.36|103.86;Vientiane|Laos|17.97|102.6;Luang Prabang|Laos|19.89|102.13;Yangon|Myanmar|16.84|96.17;Bandar Seri Begawan|Brunei|4.89|114.94;
Tokyo|Japan|35.682|139.759;Osaka|Japan|34.694|135.502;Kyoto|Japan|35.012|135.768;Sapporo|Japan|43.062|141.354;Fukuoka|Japan|33.59|130.4;Hiroshima|Japan|34.39|132.46;Nara|Japan|34.69|135.8;Okinawa|Japan|26.21|127.68;Seoul|South Korea|37.566|126.978;Busan|South Korea|35.18|129.08;Jeju|South Korea|33.5|126.53;Beijing|China|39.904|116.407;Shanghai|China|31.23|121.474;Guangzhou|China|23.13|113.26;Shenzhen|China|22.54|114.06;Chengdu|China|30.66|104.06;Xi'an|China|34.34|108.94;Hong Kong|China|22.32|114.17;Macau|China|22.2|113.54;Taipei|Taiwan|25.033|121.565;
Delhi|India|28.614|77.209;Mumbai|India|19.076|72.878;Jaipur|India|26.91|75.79;Agra|India|27.18|78.01;Goa|India|15.5|73.83;Chennai|India|13.08|80.27;Bengaluru|India|12.97|77.59;Kathmandu|Nepal|27.717|85.324;Colombo|Sri Lanka|6.927|79.861;Kandy|Sri Lanka|7.29|80.63;Malé|Maldives|4.175|73.509;Dubai|UAE|25.205|55.27;Abu Dhabi|UAE|24.45|54.38;Doha|Qatar|25.29|51.53;Istanbul|Turkey|41.008|28.978;Cappadocia|Turkey|38.64|34.83;Mecca|Saudi Arabia|21.42|39.83;Medina|Saudi Arabia|24.47|39.61;Cairo|Egypt|30.044|31.236;Marrakesh|Morocco|31.63|-8.0;
London|UK|51.507|-0.128;Edinburgh|UK|55.953|-3.188;Manchester|UK|53.48|-2.24;Paris|France|48.857|2.352;Nice|France|43.7|7.27;Lyon|France|45.76|4.84;Amsterdam|Netherlands|52.37|4.9;Brussels|Belgium|50.85|4.35;Berlin|Germany|52.52|13.405;Munich|Germany|48.14|11.58;Frankfurt|Germany|50.11|8.68;Zurich|Switzerland|47.38|8.54;Interlaken|Switzerland|46.69|7.86;Geneva|Switzerland|46.2|6.14;Vienna|Austria|48.21|16.37;Salzburg|Austria|47.81|13.05;Prague|Czechia|50.08|14.44;Budapest|Hungary|47.5|19.04;Rome|Italy|41.903|12.496;Florence|Italy|43.77|11.26;Venice|Italy|45.44|12.32;Milan|Italy|45.46|9.19;Naples|Italy|40.85|14.27;Madrid|Spain|40.417|-3.704;Barcelona|Spain|41.39|2.17;Seville|Spain|37.39|-5.98;Lisbon|Portugal|38.72|-9.14;Porto|Portugal|41.15|-8.61;Athens|Greece|37.98|23.73;Santorini|Greece|36.39|25.46;Copenhagen|Denmark|55.68|12.57;Stockholm|Sweden|59.33|18.07;Oslo|Norway|59.91|10.75;Reykjavik|Iceland|64.15|-21.94;Dublin|Ireland|53.35|-6.26;Moscow|Russia|55.76|37.62;
New York|USA|40.713|-74.006;Los Angeles|USA|34.052|-118.244;San Francisco|USA|37.775|-122.419;Las Vegas|USA|36.17|-115.14;Chicago|USA|41.88|-87.63;Miami|USA|25.76|-80.19;Orlando|USA|28.54|-81.38;Washington|USA|38.9|-77.04;Seattle|USA|47.61|-122.33;Honolulu|USA|21.31|-157.86;Toronto|Canada|43.65|-79.38;Vancouver|Canada|49.28|-123.12;Mexico City|Mexico|19.43|-99.13;Cancún|Mexico|21.16|-86.85;Rio de Janeiro|Brazil|-22.91|-43.17;Buenos Aires|Argentina|-34.6|-58.38;Lima|Peru|-12.05|-77.04;Cusco|Peru|-13.53|-71.97;
Sydney|Australia|-33.869|151.209;Melbourne|Australia|-37.814|144.963;Brisbane|Australia|-27.47|153.03;Perth|Australia|-31.95|115.86;Gold Coast|Australia|-28.02|153.4;Cairns|Australia|-16.92|145.77;Auckland|New Zealand|-36.85|174.76;Queenstown|New Zealand|-45.03|168.66;Cape Town|South Africa|-33.92|18.42;Nairobi|Kenya|-1.29|36.82;Zanzibar|Tanzania|-6.16|39.19`
  .split(';').map(s => s.trim()).filter(Boolean).map(s => { const [name, country, lat, lon] = s.split('|'); return { name, country, lat: +lat, lon: +lon }; });
function placeName(c) {
  if (!c) return null;
  let best = null, bd = 1e9;
  for (const x of CITIES) { const d = km(c, x); if (d < bd) { bd = d; best = x; } }
  if (best && bd < 45) return { name: best.name, country: best.country };
  if (best && bd < 150) return { name: 'Near ' + best.name, country: best.country };
  return { name: `${Math.abs(c.lat).toFixed(2)}°${c.lat >= 0 ? 'N' : 'S'}, ${Math.abs(c.lon).toFixed(2)}°${c.lon >= 0 ? 'E' : 'W'}`, country: '' };
}

/* ---------------- Image processing ---------------- */
function mkCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
async function toBlob(c, type = 'image/jpeg', q = 0.86) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality: q });
  return new Promise(r => c.toBlob(r, type, q));
}
async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}
async function resizeTo(src, max, q) {
  const sw = src.width, sh = src.height, s = Math.min(1, max / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
  const c = mkCanvas(w, h), x = c.getContext('2d');
  x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h);
  return { blob: await toBlob(c, 'image/jpeg', q), w, h };
}
async function processFile(file, tripId, day, idx = 0) {
  const buf = await file.arrayBuffer();
  let meta = {};
  try { meta = readExif(buf); } catch (e) { meta = {}; }
  const img = await decode(file);
  const full = await resizeTo(img, 2000, 0.88);
  const thumb = await resizeTo(img, 520, 0.8);
  if (img.close) img.close();
  return {
    id: uid(), tripId, name: file.name, blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h,
    time: day ? dayTime(day, meta.time, idx) : (meta.time || file.lastModified || Date.now()), exifTime: !!meta.time, day: day || null,
    lat: meta.lat ?? null, lon: meta.lon ?? null
  };
}
/** Put a photo on the chosen day: keep its EXIF time-of-day when it has one, else space them out from 9am in pick order. */
function dayTime(day, exif, idx) {
  const d0 = parseYmd(day);
  if (exif) return d0 + (exif - startOfDay(exif));
  return d0 + 9 * 3600e3 + idx * 60e3;
}

/* image caches */
const thumbURLs = new Map();
function thumbURL(p) { if (!thumbURLs.has(p.id)) thumbURLs.set(p.id, URL.createObjectURL(p.thumb)); return thumbURLs.get(p.id); }
const bmpCache = new Map(); // thumbs as ImageBitmap for canvas preview
async function thumbBitmap(id) {
  if (bmpCache.has(id)) return bmpCache.get(id);
  const p = S.photos.get(id); if (!p) return null;
  const pr = createImageBitmap(p.thumb).catch(() => null);
  bmpCache.set(id, pr); return pr;
}

/* ---------------- Grouping: photos -> chapters (stops) ---------------- */
function centroid(ps) {
  const g = ps.filter(p => p.lat != null);
  if (!g.length) return null;
  return { lat: g.reduce((a, p) => a + p.lat, 0) / g.length, lon: g.reduce((a, p) => a + p.lon, 0) / g.length };
}
function autoGroup(photos, oldChapters = [], trip = S.trip || {}) {
  const daily = trip.uploadMode === 'daily', days = trip.days || {};
  const ps = [...photos].sort((a, b) => a.time - b.time);
  const groups = []; let cur = null;
  for (const p of ps) {
    if (!cur) { cur = [p]; continue; }
    const last = cur[cur.length - 1];
    const gapH = (p.time - last.time) / 3600e3;
    const c = centroid(cur);
    const dist = (c && p.lat != null) ? km(c, p) : 0;
    const dayChange = dayKey(p.time) !== dayKey(last.time);
    const brk = daily ? dayChange : (gapH > 5 || dist > 30 || (dayChange && gapH > 2));
    if (brk) { groups.push(cur); cur = [p]; }
    else cur.push(p);
  }
  if (cur) groups.push(cur);

  const owner = new Map();
  oldChapters.forEach(ch => ch.photoIds.forEach(id => owner.set(id, ch)));
  const used = new Set();
  const t0 = tripT0(trip, ps);
  return groups.map(g => {
    const c = centroid(g), pl = placeName(c), key = ymd(g[0].time), dinfo = days[key] || {};
    const day = Math.round((startOfDay(g[0].time) - t0) / 864e5) + 1;
    const ch = {
      id: uid(), photoIds: g.map(p => p.id), start: g[0].time, end: g[g.length - 1].time, day, dayKey: key,
      lat: c ? c.lat : null, lon: c ? c.lon : null,
      place: dinfo.place || (pl ? pl.name : '') || trip.destination || '', country: pl ? pl.country : '',
      title: dinfo.place || (pl ? pl.name : '') || `Day ${day}`, caption: '', edited: false
    };
    // keep user edits from the previous grouping when chapters overlap
    const votes = new Map();
    g.forEach(p => { const o = owner.get(p.id); if (o) votes.set(o, (votes.get(o) || 0) + 1); });
    let best = null, bv = 0; votes.forEach((v, o) => { if (v > bv && !used.has(o.id)) { bv = v; best = o; } });
    if (best && bv >= g.length / 2) {
      used.add(best.id); ch.id = best.id;
      if (best.edited) { ch.title = best.title; ch.caption = best.caption; ch.edited = true; }
      else if (best.caption) ch.caption = best.caption;
    }
    if (daily) { if (dinfo.place) ch.title = dinfo.place; if (dinfo.caption) { ch.caption = dinfo.caption; ch.edited = true; } }
    return ch;
  });
}
function recomputeChapter(ch) {
  const g = ch.photoIds.map(id => S.photos.get(id)).filter(Boolean).sort((a, b) => a.time - b.time);
  ch.photoIds = g.map(p => p.id);
  if (!g.length) return;
  ch.start = g[0].time; ch.end = g[g.length - 1].time;
  const c = centroid(g); ch.lat = c ? c.lat : null; ch.lon = c ? c.lon : null;
}

/* ---------------- Story mode: auto captions ---------------- */
function timeOfDay(t) { const h = new Date(t).getHours(); return h < 11 ? 'morning' : h < 15 ? 'afternoon' : h < 19 ? 'late afternoon' : 'evening'; }
function storyCaption(ch, i, total) {
  const trip = S.trip || {};
  const raw = (ch.place || '').replace(/^Near /, ''), place = raw && !/°/.test(raw) ? raw : (trip.destination || '');
  const n = ch.photoIds.length, ph = (k, w = 'photo') => `${k} ${w}${k > 1 ? 's' : ''}`;
  const tod = timeOfDay(ch.start), dur = (ch.end - ch.start) / 3600e3;
  const span = dur > 20 ? `${Math.round(dur / 24) + 1} days` : dur > 3 ? `a full ${tod}` : `a ${tod}`;
  const who = trip.travellers ? ` with ${trip.travellers}` : '';
  const kind = trip.tripType ? `${/^(Umrah|Hajj)$/.test(trip.tripType) ? trip.tripType : trip.tripType.toLowerCase()} ` : '';
  if (/umrah|hajj/i.test(trip.tripType || '')) {
    const pl = place || 'the Holy Land', U = [
      `Day ${ch.day} in ${pl}. Alhamdulillah for every step of this journey.`,
      `${cap(tod)} in ${pl} — quiet moments of prayer and reflection.`,
      `Day ${ch.day}: ${pl}. Hearts full, feet tired, grateful for being here.`,
      `Blessed ${tod} in ${pl}. ${cap(ph(n, 'moment'))} we will always treasure.`
    ];
    if (i === 0) return `Bismillah — our ${trip.tripType} journey${who} begins in ${pl}. May it be accepted.`;
    if (i === total - 1 && total > 1) return `Our last day, in ${pl}. Leaving with grateful hearts and du'a to return again.`;
    return U[i % U.length];
  }
  if (place) {
    if (i === 0) return `Day ${ch.day} of our ${kind}trip${who}: where it all began. We started in ${place} and spent ${span} soaking it in — ${ph(n)} to prove it.`;
    if (i === total - 1 && total > 1) return `The last stop: ${place}. ${ph(n, 'final moment')} before heading home, already planning the next trip.`;
    const T = [
      `Day ${ch.day} brought us to ${place}. ${cap(span)} of wandering, ${ph(n, 'moment')} worth keeping.`,
      `${cap(tod)} in ${place} — ${ph(n, 'snapshot')} from ${span} we won't forget.`,
      `Next up, ${place}. New streets, new flavours, and ${ph(n)} along the way.`,
      `${place} on day ${ch.day}: slow, happy and exactly what we needed.`,
      `We reached ${place} in the ${tod}. The camera barely stayed in the bag — ${ph(n, 'shot')}.`
    ];
    return T[i % T.length];
  }
  if (i === 0) return `Day ${ch.day}: where our ${kind}trip${who} began. ${cap(ph(n))} to remember the very first day.`;
  if (i === total - 1 && total > 1) return `Our final day — ${ph(n, 'last moment')} before heading home, already missing it.`;
  const T2 = [
    `Day ${ch.day}: ${span} of making memories together — ${ph(n)}.`,
    `Another ${tod} to remember. ${cap(ph(n, 'snapshot'))} we won't forget.`,
    `Day ${ch.day} was all about slowing down and enjoying the moment.`,
    `Laughs, good food and ${ph(n)} from day ${ch.day}.`
  ];
  return T2[i % T2.length];
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------------- Book model ---------------- */
const LAYOUTS = {
  '1': { n: 1, rects: [[0, 0, 1, 1]] },
  '1full': { n: 1, rects: [[0, 0, 1, 1]], bleed: true },
  '2h': { n: 2, rects: [[0, 0, .5, 1], [.5, 0, .5, 1]] },
  '2v': { n: 2, rects: [[0, 0, 1, .5], [0, .5, 1, .5]] },
  '3a': { n: 3, rects: [[0, 0, .6, 1], [.6, 0, .4, .5], [.6, .5, .4, .5]] },
  '3b': { n: 3, rects: [[0, 0, 1, .58], [0, .58, .5, .42], [.5, .58, .5, .42]] },
  '3c': { n: 3, rects: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  '4': { n: 4, rects: [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]] },
  '4b': { n: 4, rects: [[0, 0, 1, .6], [0, .6, 1 / 3, .4], [1 / 3, .6, 1 / 3, .4], [2 / 3, .6, 1 / 3, .4]] }
};
const layoutsFor = n => Object.keys(LAYOUTS).filter(k => LAYOUTS[k].n === n);
const SIZES = {
  square: { label: 'Square', sub: '20×20 cm', w: 8, h: 8 },
  landscape: { label: 'Landscape', sub: '28×21 cm', w: 11, h: 8.5 },
  portrait: { label: 'Portrait', sub: '21×28 cm', w: 8.5, h: 11 }
};
const COVERS = {
  softcover: { label: 'Softcover', sub: 'Light & flexible' },
  hardcover: { label: 'Hardcover', sub: 'Classic, durable' },
  layflat: { label: 'Layflat', sub: 'Seamless spreads' }
};
const THEMES = {
  classic: { label: 'Classic', bg: '#FBF8F3', ink: '#2B2622', muted: '#857a70', accent: '#C0573E', font: 'Georgia, "DejaVu Serif", "Times New Roman", serif', head: 'Georgia, "DejaVu Serif", serif', map: '#EFE8DC' },
  minimal: { label: 'Minimal', bg: '#FFFFFF', ink: '#1D1D1F', muted: '#8a8f94', accent: '#0E5E6F', font: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', head: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', map: '#EEF3F4' },
  bold: { label: 'Night', start: '#127083', bg: '#0F2D36', ink: '#F4EFE6', muted: '#9fb3b8', accent: '#FF8A65', font: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', head: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', map: '#163C47' }
};
function pickLayout(ids, size) {
  const ps = ids.map(id => S.photos.get(id)).filter(Boolean);
  const land = ps.filter(p => p.w >= p.h).length;
  const wide = size === 'landscape';
  switch (ids.length) {
    case 1: return '1';
    case 2: return wide ? '2h' : (land === 2 ? '2v' : '2h');
    case 3: return land >= 2 ? '3b' : (wide ? '3c' : '3a');
    default: return land >= 3 ? '4b' : '4';
  }
}
function buildBook(trip) {
  const pages = [];
  const allIds = trip.chapters.flatMap(c => c.photoIds);
  const coverId = trip.coverId && S.photos.has(trip.coverId) ? trip.coverId : allIds[0];
  pages.push({ id: uid(), type: 'cover', photoIds: coverId ? [coverId] : [] });
  if (trip.chapters.some(c => c.lat != null)) pages.push({ id: uid(), type: 'map', photoIds: [] });
  const seq = [3, 2, 4, 1, 3, 4, 2];
  let k = 0;
  for (const ch of trip.chapters) {
    const ids = ch.photoIds.filter(id => id !== coverId || ch.photoIds.length === 1);
    const hero = ids.shift();
    pages.push({ id: uid(), type: 'chapter', chapterId: ch.id, photoIds: hero ? [hero] : [] });
    while (ids.length) {
      let n = Math.min(seq[k++ % seq.length], ids.length);
      if (ids.length - n === 1 && n > 1 && n < 4) n++;
      const chunk = ids.splice(0, n);
      pages.push({ id: uid(), type: 'photos', chapterId: ch.id, photoIds: chunk, layout: chunk.length === 1 && k % 2 ? '1full' : pickLayout(chunk, trip.size), caption: '' });
    }
  }
  // printed books need an even page count; end page sits on the right.
  if (pages.length % 2 === 1) pages.push({ id: uid(), type: 'notes', photoIds: [] });
  pages.push({ id: uid(), type: 'end', photoIds: [] });
  return pages;
}
function tripStats(trip) {
  const pts = trip.chapters.filter(c => c.lat != null);
  let dist = 0; for (let i = 1; i < pts.length; i++) dist += km(pts[i - 1], pts[i]);
  const all = trip.chapters.flatMap(c => c.photoIds).map(id => S.photos.get(id)).filter(Boolean);
  const t = all.map(p => p.time);
  let days = t.length ? Math.round((startOfDay(Math.max(...t)) - startOfDay(Math.min(...t))) / 864e5) + 1 : 0;
  const a = parseYmd(trip.startDate), b = parseYmd(trip.endDate);
  if (a != null && b != null && b >= a) days = Math.max(days, Math.round((b - a) / 864e5) + 1);
  const countries = new Set(trip.chapters.map(c => c.country).filter(Boolean));
  return { km: Math.round(dist), days, places: new Set(trip.chapters.map(c => c.place || c.title)).size, photos: all.length, countries: countries.size, start: t.length ? Math.min(...t) : null, end: t.length ? Math.max(...t) : null };
}

/* ---------------- Canvas renderer (shared by preview + PDF) ---------------- */
function drawCover(ctx, img, x, y, w, h, radius = 0) {
  ctx.save();
  ctx.beginPath();
  if (radius > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, radius); else ctx.rect(x, y, w, h);
  ctx.clip();
  if (img) {
    const s = Math.max(w / img.width, h / img.height), sw = w / s, sh = h / s;
    ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
  } else {
    ctx.fillStyle = '#d9d3c9'; ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}
function wrap(ctx, text, maxW) {
  const words = String(text || '').split(/\s+/).filter(Boolean), lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}
function textBlock(ctx, text, x, y, maxW, lh, maxLines = 99, align = 'left') {
  let lines = wrap(ctx, text, maxW);
  if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
  ctx.textAlign = align;
  const ax = align === 'center' ? x + maxW / 2 : align === 'right' ? x + maxW : x;
  lines.forEach((l, i) => ctx.fillText(l, ax, y + i * lh));
  ctx.textAlign = 'left';
  return lines.length * lh;
}
function drawRouteMap(ctx, x, y, w, h, trip, T, u) {
  const pts = trip.chapters.filter(c => c.lat != null).map((c, i) => ({ ...c, n: trip.chapters.indexOf(c) + 1 }));
  ctx.save();
  ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, 14 * u); else ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = T.map; ctx.fillRect(x, y, w, h);
  if (!pts.length) {
    ctx.fillStyle = T.muted; ctx.font = `${16 * u}px ${T.font}`; ctx.textAlign = 'center';
    ctx.fillText('No GPS data in these photos', x + w / 2, y + h / 2); ctx.restore(); ctx.textAlign = 'left'; return;
  }
  const mLat = pts.reduce((a, p) => a + p.lat, 0) / pts.length, kx = Math.cos(mLat * Math.PI / 180);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  pts.forEach(p => { const X = p.lon * kx, Y = -p.lat; minX = Math.min(minX, X); maxX = Math.max(maxX, X); minY = Math.min(minY, Y); maxY = Math.max(maxY, Y); });
  const span = Math.max(maxX - minX, maxY - minY, 0.08);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const pad = 0.18, sc = Math.min(w, h) * (1 - 2 * pad) / span * Math.min(1.35, Math.max(w, h) / Math.min(w, h));
  let s = Math.min(w * (1 - 2 * pad) / Math.max(maxX - minX, 1e-6), h * (1 - 2 * pad) / Math.max(maxY - minY, 1e-6), sc);
  const P = p => [x + w / 2 + (p.lon * kx - cx) * s, y + h / 2 + (-p.lat - cy) * s];
  // graticule
  const deg = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20].find(d => d * s > 70 * u) || 30;
  ctx.strokeStyle = T.ink; ctx.globalAlpha = 0.07; ctx.lineWidth = 1 * u;
  const lonL = (cx - w / 2 / s) / kx, lonR = (cx + w / 2 / s) / kx, latT = -(cy - h / 2 / s), latB = -(cy + h / 2 / s);
  for (let lo = Math.floor(lonL / deg) * deg; lo <= lonR; lo += deg) { const [a] = P({ lat: 0, lon: lo }); ctx.beginPath(); ctx.moveTo(a, y); ctx.lineTo(a, y + h); ctx.stroke(); }
  for (let la = Math.floor(latB / deg) * deg; la <= latT; la += deg) { const [, b] = P({ lat: la, lon: 0 }); ctx.beginPath(); ctx.moveTo(x, b); ctx.lineTo(x + w, b); ctx.stroke(); }
  ctx.globalAlpha = 1;
  // route
  ctx.strokeStyle = T.accent; ctx.lineWidth = 3.2 * u; ctx.setLineDash([2 * u, 9 * u]); ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [px, py] = P(p);
    if (!i) { ctx.moveTo(px, py); return; }
    const [qx, qy] = P(pts[i - 1]); const mx = (px + qx) / 2, my = (py + qy) / 2;
    const dx = px - qx, dy = py - qy; const bend = 0.18 * (i % 2 ? 1 : -1);
    ctx.quadraticCurveTo(mx - dy * bend, my + dx * bend, px, py);
  });
  ctx.stroke(); ctx.setLineDash([]);
  // markers, then labels placed to avoid collisions
  const marks = pts.map(p => P(p)), r = 12 * u, boxes = [];
  marks.forEach(([px, py]) => boxes.push([px - r - 3 * u, py - r - 3 * u, px + r + 3 * u, py + r + 3 * u]));
  const hit = b => boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  pts.forEach((p, i) => {
    const [px, py] = marks[i];
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py, r + 3 * u, 0, 7); ctx.fill();
    ctx.fillStyle = i === 0 ? (T.start || T.ink) : T.accent; ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${11 * u}px ${T.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(p.n), px, py + 0.5 * u); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  });
  ctx.font = `600 ${13 * u}px ${T.font}`;
  const done = new Set();
  pts.forEach((p, i) => {
    const label = (p.place || p.title || '').replace(/^Near /, '');
    if (!label || done.has(label)) return;
    const [px, py] = marks[i], tw = ctx.measureText(label).width, bh = 18 * u, padX = 5 * u, off = r + 8 * u;
    const cands = [[px + off, py - bh / 2], [px - off - tw - 2 * padX, py - bh / 2], [px - tw / 2 - padX, py - off - bh], [px - tw / 2 - padX, py + off],
      [px + off, py - bh * 1.6], [px + off, py + bh * 0.6], [px - off - tw - 2 * padX, py - bh * 1.6], [px - off - tw - 2 * padX, py + bh * 0.6]];
    let pick = null;
    for (const [bx, by] of cands) {
      const b = [bx, by, bx + tw + 2 * padX, by + bh];
      if (b[0] < x + 4 * u || b[2] > x + w - 4 * u || b[1] < y + 4 * u || b[3] > y + h - 4 * u) continue;
      if (!hit(b)) { pick = b; break; }
    }
    if (!pick) return; // no room; number marker still shows
    boxes.push(pick); done.add(label);
    ctx.fillStyle = T.bg; ctx.globalAlpha = 0.88; ctx.fillRect(pick[0], pick[1], pick[2] - pick[0], bh); ctx.globalAlpha = 1;
    ctx.fillStyle = T.ink; ctx.fillText(label, pick[0] + padX, pick[1] + bh - 5 * u);
  });
  // compass
  ctx.fillStyle = T.ink; ctx.globalAlpha = 0.5; ctx.font = `bold ${12 * u}px ${T.font}`; ctx.textAlign = 'center';
  ctx.fillText('N', x + w - 24 * u, y + 26 * u);
  ctx.beginPath(); ctx.moveTo(x + w - 24 * u, y + 32 * u); ctx.lineTo(x + w - 29 * u, y + 46 * u); ctx.lineTo(x + w - 19 * u, y + 46 * u); ctx.fill();
  ctx.globalAlpha = 1; ctx.textAlign = 'left';
  ctx.restore();
}
/** Render one book page into ctx at W×H. img(id) => ImageBitmap|null */
function renderPage(ctx, W, H, page, trip, img, pageNo) {
  const T = THEMES[trip.theme] || THEMES.classic;
  const u = Math.min(W, H) / 600; // design unit
  const m = 38 * u;
  ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';
  const chapter = page.chapterId ? trip.chapters.find(c => c.id === page.chapterId) : null;
  const folio = () => {
    if (!pageNo) return;
    ctx.fillStyle = T.muted; ctx.font = `${10 * u}px ${T.font}`; ctx.textAlign = 'center';
    ctx.fillText(String(pageNo), W / 2, H - 14 * u); ctx.textAlign = 'left';
  };
  switch (page.type) {
    case 'cover': {
      drawCover(ctx, img(page.photoIds[0]), 0, 0, W, H);
      const g = ctx.createLinearGradient(0, H * 0.45, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.72)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${46 * u}px ${T.head}`;
      const lines = wrap(ctx, trip.title || 'Our Trip', W - 2 * m).slice(0, 3);
      const sub = subOf(trip);
      let yy = H - m - (sub ? 34 * u : 0) - (lines.length - 1) * 52 * u;
      lines.forEach((l, i) => ctx.fillText(l, m, yy + i * 52 * u));
      if (sub) { ctx.font = `${17 * u}px ${T.font}`; ctx.globalAlpha = .9; ctx.fillText(sub, m, H - m); ctx.globalAlpha = 1; }
      ctx.fillStyle = T.accent; ctx.fillRect(m, yy - 66 * u, 46 * u, 5 * u);
      break;
    }
    case 'map': {
      const st = tripStats(trip);
      ctx.fillStyle = T.accent; ctx.font = `bold ${11 * u}px ${T.font}`;
      ctx.fillText('THE ROUTE', m, m + 8 * u);
      ctx.fillStyle = T.ink; ctx.font = `bold ${28 * u}px ${T.head}`;
      ctx.fillText(trip.title || 'Our Trip', m, m + 42 * u);
      const statH = 64 * u, top = m + 62 * u;
      drawRouteMap(ctx, m, top, W - 2 * m, H - top - m - statH - 16 * u, trip, T, u);
      const items = [[st.days, st.days === 1 ? 'day' : 'days'], [st.km.toLocaleString(), 'km'], [st.places, st.places === 1 ? 'stop' : 'stops'], [st.photos, 'photos']];
      const cw = (W - 2 * m) / items.length;
      items.forEach(([v, l], i) => {
        const cx = m + cw * i + cw / 2;
        ctx.textAlign = 'center'; ctx.fillStyle = T.ink; ctx.font = `bold ${24 * u}px ${T.head}`;
        ctx.fillText(String(v), cx, H - m - 24 * u);
        ctx.fillStyle = T.muted; ctx.font = `${10 * u}px ${T.font}`;
        ctx.fillText(l.toUpperCase(), cx, H - m - 6 * u);
      });
      ctx.textAlign = 'left';
      break;
    }
    case 'chapter': {
      const ch = chapter || {};
      const portrait = H > W * 1.05, wide = W > H * 1.1;
      if (wide) {
        const pw = W * 0.56;
        drawCover(ctx, img(page.photoIds[0]), 0, 0, pw, H);
        const tx = pw + 30 * u, tw = W - tx - m;
        let ty = H * 0.3;
        ctx.fillStyle = T.accent; ctx.font = `bold ${11 * u}px ${T.font}`;
        ctx.fillText(`DAY ${ch.day || ''} · ${ch.start ? fmtDate(ch.start).toUpperCase() : ''}`, tx, ty);
        ctx.fillStyle = T.ink; ctx.font = `bold ${30 * u}px ${T.head}`;
        ty += 16 * u + textBlock(ctx, ch.title, tx, ty + 30 * u, tw, 36 * u, 3);
        if (ch.country && ch.place !== ch.title) { ctx.fillStyle = T.muted; ctx.font = `${13 * u}px ${T.font}`; ctx.fillText([ch.place, ch.country].filter(Boolean).join(', '), tx, ty + 18 * u); ty += 22 * u; }
        else if (ch.country) { ctx.fillStyle = T.muted; ctx.font = `${13 * u}px ${T.font}`; ctx.fillText(ch.country, tx, ty + 18 * u); ty += 22 * u; }
        ctx.fillStyle = T.ink; ctx.font = `${14 * u}px ${T.font}`; ctx.globalAlpha = .85;
        textBlock(ctx, ch.caption, tx, ty + 34 * u, tw, 21 * u, 9); ctx.globalAlpha = 1;
      } else {
        const ph = H * (portrait ? 0.56 : 0.52);
        drawCover(ctx, img(page.photoIds[0]), 0, 0, W, ph);
        let ty = ph + 40 * u;
        ctx.fillStyle = T.accent; ctx.font = `bold ${11 * u}px ${T.font}`;
        ctx.fillText(`DAY ${ch.day || ''} · ${ch.start ? fmtDate(ch.start).toUpperCase() : ''}`, m, ty);
        ctx.fillStyle = T.ink; ctx.font = `bold ${30 * u}px ${T.head}`;
        ty += 4 * u + textBlock(ctx, ch.title, m, ty + 34 * u, W - 2 * m, 36 * u, 2);
        if (ch.country) { ctx.fillStyle = T.muted; ctx.font = `${13 * u}px ${T.font}`; ctx.fillText(ch.place && ch.place !== ch.title ? `${ch.place}, ${ch.country}` : ch.country, m, ty + 20 * u); ty += 24 * u; }
        ctx.fillStyle = T.ink; ctx.font = `${14 * u}px ${T.font}`; ctx.globalAlpha = .85;
        const lh = 21 * u, room = Math.max(1, Math.floor((H - m - (ty + 30 * u)) / lh) + 1);
        textBlock(ctx, ch.caption, m, ty + 34 * u, W - 2 * m, lh, room); ctx.globalAlpha = 1;
      }
      break;
    }
    case 'photos': {
      const L = LAYOUTS[page.layout] || LAYOUTS[pickLayout(page.photoIds, trip.size)];
      const capH = page.caption ? 44 * u : 0;
      if (L.bleed) {
        drawCover(ctx, img(page.photoIds[0]), 0, 0, W, H);
        if (page.caption) {
          const g = ctx.createLinearGradient(0, H - 120 * u, 0, H); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.6)');
          ctx.fillStyle = g; ctx.fillRect(0, H - 120 * u, W, 120 * u);
          ctx.fillStyle = '#fff'; ctx.font = `italic ${14 * u}px ${T.font}`; textBlock(ctx, page.caption, m, H - m + 4 * u, W - 2 * m, 20 * u, 2);
        }
        break;
      }
      const gap = 8 * u, bx = m, by = m, bw = W - 2 * m, bh = H - 2 * m - capH;
      L.rects.forEach((r, i) => {
        const id = page.photoIds[i]; if (!id) return;
        const x = bx + r[0] * bw + (r[0] > 0 ? gap / 2 : 0), y = by + r[1] * bh + (r[1] > 0 ? gap / 2 : 0);
        const w = r[2] * bw - (r[0] > 0 ? gap / 2 : 0) - (r[0] + r[2] < 0.999 ? gap / 2 : 0);
        const h = r[3] * bh - (r[1] > 0 ? gap / 2 : 0) - (r[1] + r[3] < 0.999 ? gap / 2 : 0);
        drawCover(ctx, img(id), x, y, w, h, 3 * u);
      });
      if (page.caption) { ctx.fillStyle = T.ink; ctx.globalAlpha = .8; ctx.font = `italic ${13 * u}px ${T.font}`; textBlock(ctx, page.caption, m, H - m - capH + 26 * u, W - 2 * m, 18 * u, 2, 'center'); ctx.globalAlpha = 1; }
      folio();
      break;
    }
    case 'notes': {
      ctx.fillStyle = T.accent; ctx.font = `bold ${11 * u}px ${T.font}`; ctx.fillText('NOTES & MEMORIES', m, m + 20 * u);
      ctx.strokeStyle = T.muted; ctx.globalAlpha = .35; ctx.lineWidth = 1 * u;
      for (let yy = m + 70 * u; yy < H - m; yy += 32 * u) { ctx.beginPath(); ctx.moveTo(m, yy); ctx.lineTo(W - m, yy); ctx.stroke(); }
      ctx.globalAlpha = 1; folio();
      break;
    }
    case 'end': {
      const st = tripStats(trip);
      ctx.textAlign = 'center'; ctx.fillStyle = T.ink;
      ctx.font = `italic ${30 * u}px ${T.head}`; ctx.fillText('Until the next adventure', W / 2, H * 0.42);
      ctx.fillStyle = T.muted; ctx.font = `${13 * u}px ${T.font}`;
      ctx.fillText(`${st.days} days · ${st.places} stops · ${st.photos} photos${st.km ? ' · ' + st.km.toLocaleString() + ' km' : ''}`, W / 2, H * 0.42 + 34 * u);
      if (trip.travellers) { ctx.font = `italic ${15 * u}px ${T.font}`; ctx.fillStyle = T.ink; ctx.fillText(`with ${trip.travellers}`, W / 2, H * 0.42 + 64 * u); }
      // MJ mark
      const s = 34 * u, x0 = W / 2 - s / 2, y0 = H - m - s - 24 * u;
      ctx.fillStyle = '#0E5E6F'; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y0, s, s, 8 * u); else ctx.rect(x0, y0, s, s); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${14 * u}px "Segoe UI", Arial, sans-serif`; ctx.textBaseline = 'middle'; ctx.fillText('MJ', W / 2, y0 + s / 2 + 1 * u); ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = T.muted; ctx.font = `${10 * u}px ${T.font}`; ctx.fillText('Made with MeyJournal', W / 2, H - m);
      ctx.textAlign = 'left';
      break;
    }
  }
}

/* ---------------- State ---------------- */
const S = { trips: [], trip: null, photos: new Map(), tab: 'timeline', sel: null };

async function loadTrips() { S.trips = (await DB.all('trips')).sort((a, b) => b.updatedAt - a.updatedAt); }
async function openTrip(id) {
  thumbURLs.forEach(u => URL.revokeObjectURL(u)); thumbURLs.clear(); bmpCache.clear();
  S.trip = await DB.get('trips', id);
  S.photos = new Map((await DB.photosOf(id)).map(p => [p.id, p]));
  S.tab = S.trip.chapters.length ? 'timeline' : 'timeline'; S.sel = null;
  render();
}
let saveTimer;
function saveTrip(now) {
  if (!S.trip) return;
  S.trip.updatedAt = Date.now();
  S.trip.autoSub = defaultSubtitle(S.trip); S.trip.count = S.photos.size;
  clearTimeout(saveTimer);
  const t = S.trip;
  const go = () => DB.put('trips', JSON.parse(JSON.stringify(t))).catch(e => toast('Could not save: ' + e.message));
  if (now) return go();
  saveTimer = setTimeout(go, 400);
}
function subOf(trip) { return trip.subtitleEdited && trip.subtitle ? trip.subtitle : (S.trip && S.trip.id === trip.id ? defaultSubtitle(trip) : (trip.autoSub || '')); }
function defaultSubtitle(trip) {
  const a = parseYmd(trip.startDate), b = parseYmd(trip.endDate || trip.startDate);
  let range = '';
  if (a != null) range = fmtRange(a, b != null && b >= a ? b : a);
  else { const st = tripStats(trip); if (st.start) range = fmtRange(st.start, st.end); }
  return [trip.destination, range].filter(Boolean).join(' · ');
}

/* ---------------- UI helpers ---------------- */
let toastT;
function toast(msg) {
  let el = $('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.remove('hide');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hide'), 2800);
}
function modal(html) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(bg);
  return { el: bg, close: () => bg.remove() };
}
function ask(title, label, value = '', okText = 'Create') {
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><div class="field"><label>${esc(label)}</label><input id="askIn" value="${esc(value)}" maxlength="80"></div><div class="row" style="justify-content:flex-end"><button class="btn line" data-a="no">Cancel</button><button class="btn primary" data-a="ok">${esc(okText)}</button></div>`);
    const inp = $('#askIn', m.el); inp.focus(); inp.select();
    const done = v => { m.close(); res(v); };
    m.el.addEventListener('click', e => { const a = e.target.dataset.a; if (a === 'ok') done(inp.value.trim()); else if (a === 'no' || e.target === m.el) done(null); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(inp.value.trim()); if (e.key === 'Escape') done(null); });
  });
}
function confirmBox(title, text, okText = 'Delete') {
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><p class="sub" style="line-height:1.5">${esc(text)}</p><div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn line" data-a="no">Cancel</button><button class="btn primary" data-a="ok">${esc(okText)}</button></div>`);
    m.el.addEventListener('click', e => { const a = e.target.dataset.a; if (a) { m.close(); res(a === 'ok'); } else if (e.target === m.el) { m.close(); res(false); } });
  });
}
function progress(title) {
  const m = modal(`<h2>${esc(title)}</h2><div class="bar"><i></i></div><div class="sub" id="pgTxt">Starting…</div>`);
  return { set(f, t) { $('.bar i', m.el).style.width = Math.round(f * 100) + '%'; if (t) $('#pgTxt', m.el).textContent = t; }, close: m.close };
}
const ICONS = {
  photos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>',
  book: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H2zM22 5h-7a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h8z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  dl: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  wand: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4V2M15 10V8M11 6h2M17 6h2M3 21l12-12"/></svg>'
};
function layoutIcon(k) {
  const L = LAYOUTS[k];
  return `<svg viewBox="0 0 36 36">${L.rects.map(r => `<rect x="${(L.bleed ? 0 : 3) + r[0] * (L.bleed ? 36 : 30) + 1}" y="${(L.bleed ? 0 : 3) + r[1] * (L.bleed ? 36 : 30) + 1}" width="${r[2] * (L.bleed ? 36 : 30) - 2}" height="${r[3] * (L.bleed ? 36 : 30) - 2}" rx="1.5" fill="#0E5E6F" opacity=".75"/>`).join('')}</svg>`;
}

/* ---------------- Views ---------------- */
function render() {
  const main = $('#main'), top = $('#topActions');
  if (!S.trip) {
    $('#crumb').textContent = '';
    top.innerHTML = '';
    main.innerHTML = homeView();
    return;
  }
  $('#crumb').textContent = '/ ' + (S.trip.title || 'Untitled trip');
  top.innerHTML = `<button class="btn ghost small" data-act="add-photos">${ICONS.plus}<span class="hide-sm">Add photos</span></button>`;
  const t = S.trip;
  const tabs = [['timeline', 'Timeline'], ['map', 'Map'], ['book', 'Photo book'], ['settings', 'Trip']];
  main.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-end">
      <div><h1>${esc(t.title || 'Untitled trip')}</h1><div class="sub">${S.photos.size ? esc(subOf(t)) + ' · ' : ''}${S.photos.size} photo${S.photos.size === 1 ? '' : 's'}</div></div>
      <div class="row trip-acts">
        ${S.photos.size ? `<button class="btn primary" data-act="play">▶ Play story</button>` : ''}
        <button class="btn line icon-btn" data-act="rename-trip" title="Rename trip" aria-label="Rename trip">✎</button>
        <button class="btn line icon-btn danger" data-act="del-trip" title="Delete trip" aria-label="Delete trip">🗑</button>
      </div>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="tabBody"></div>`;
  const body = $('#tabBody');
  const daily = t.uploadMode === 'daily';
  if (!S.photos.size && S.tab !== 'settings' && !(daily && S.tab === 'timeline')) { body.innerHTML = dropView(); bindDrop(); return; }
  if (S.tab === 'timeline') body.innerHTML = daily ? dailyView() : timelineView();
  if (S.tab === 'map') { body.innerHTML = mapView(); drawMapTab(); }
  if (S.tab === 'book') { body.innerHTML = bookView(); mountBook(); }
  if (S.tab === 'settings') body.innerHTML = settingsView();
}
function homeView() {
  const cards = S.trips.map(t => `
    <div class="trip-card" data-open="${t.id}">
      <div class="cv" data-cover="${t.id}"><span class="badge">${t.count || 0} photos</span></div>
      <div class="meta"><div><b>${esc(t.title || 'Untitled trip')}</b><span class="sub">${esc(t.count ? subOf(t) : 'No photos yet')}</span></div>
        <div class="card-acts"><button class="ib2" data-act="rename-trip" data-id="${t.id}" title="Rename" aria-label="Rename trip">✎</button><button class="ib2" data-act="del-trip" data-id="${t.id}" title="Delete" aria-label="Delete trip">🗑</button></div></div>
    </div>`).join('');
  queueMicrotask(loadCardCovers);
  return `
    <section class="hero">
      <div style="flex:1">
        <h1 style="font-size:28px">Turn your trip photos into a book</h1>
        <p>Drop in up to ${MAX_PHOTOS.toLocaleString()} photos. MeyJournal reads their dates and GPS, builds a day-by-day timeline with a route map, writes first-draft captions and lays out a print-ready book — softcover, hardcover or layflat.</p>
        <div class="row"><button class="btn primary" data-act="new-trip">${ICONS.plus} New trip</button><button class="btn ghost" data-act="templates">Templates & samples</button></div>
      </div>
      <div class="art">${$('#homeBtn svg').outerHTML.replace('<svg', '<svg style="width:120px;height:120px"')}</div>
    </section>
    <h2 style="margin-top:28px">Your trips</h2>
    <div class="grid-trips">
      <button class="new-card" data-act="new-trip"><span class="plus">+</span>New trip</button>
      ${cards}
    </div>
    ${templatesSection()}`;
}
async function loadCardCovers() {
  for (const t of S.trips) {
    if (!t.coverId) continue;
    const p = await DB.get('photos', t.coverId);
    const el = document.querySelector(`[data-cover="${t.id}"]`);
    if (p && el) el.style.backgroundImage = `url(${URL.createObjectURL(p.thumb)})`;
  }
}
function dropView() {
  return `<label class="drop" id="drop" for="fileIn">
    ${ICONS.photos}
    <b>Add your trip photos</b>
    <div>Tap to choose, or drag & drop up to ${MAX_PHOTOS.toLocaleString()} photos here.<br>Original JPEGs from your camera or phone keep their date and location.</div>
    <div style="margin-top:16px"><span class="btn primary">${ICONS.plus} Choose photos</span></div>
  </label>`;
}
function bindDrop() {
  const d = $('#drop'); if (!d) return;
  ['dragenter', 'dragover'].forEach(ev => d.addEventListener(ev, e => { e.preventDefault(); d.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => d.addEventListener(ev, e => { e.preventDefault(); d.classList.remove('over'); }));
  d.addEventListener('drop', e => importFiles(e.dataTransfer.files));
}
function timelineView() {
  const t = S.trip, chs = t.chapters;
  const noGps = [...S.photos.values()].every(p => p.lat == null);
  const undated = [...S.photos.values()].filter(p => !p.exifTime && !p.day).length;
  return `
    ${undated ? `<div class="hint">📅 <span><b>${undated} photo${undated > 1 ? 's have' : ' has'} no date</b> (common when picking photos on Android or from WhatsApp), so ${undated > 1 ? 'they may be' : 'it may be'} on the wrong day. Switch to <b>day-by-day upload</b> to put each photo on the right day.</span><button class="btn teal small" data-act="go-daily">Switch to day by day</button></div>` : ''}
    <div class="row" style="justify-content:space-between;margin-bottom:16px">
      <div class="sub">${chs.length} stop${chs.length === 1 ? '' : 's'}, grouped automatically by time and location.${noGps ? ' <b>No GPS found</b> — grouped by time only; rename stops below.' : ''}</div>
      <div class="row"><button class="btn line small" data-act="story">${ICONS.wand} Write captions (Story mode)</button><button class="btn teal small" data-tab="book">${ICONS.book} Make photo book</button></div>
    </div>
    ${chs.map((ch, i) => `
      <div class="chapter" data-ch="${ch.id}">
        <div class="rail"><div class="dot">${i + 1}</div>${i < chs.length - 1 ? '<div class="vline"></div>' : ''}</div>
        <div class="body">
          <div class="kicker">Day ${ch.day} · ${fmtDate(ch.start)}${ch.country ? ' · ' + esc(ch.country) : ''}</div>
          <input class="title" data-f="title" value="${esc(ch.title)}" placeholder="Name this stop">
          <textarea data-f="caption" rows="2" placeholder="Add a caption — or use Story mode to draft one">${esc(ch.caption)}</textarea>
          <div class="thumbs">${ch.photoIds.map(id => { const p = S.photos.get(id); if (!p) return ''; return `
            <div class="thumb" data-pid="${id}"><img loading="lazy" src="${thumbURL(p)}" alt="">
              <div class="acts"><button class="ib ${t.coverId === id ? 'on' : ''}" data-act="cover" title="Use as book cover">★</button><button class="ib" data-act="del-photo" title="Remove from trip">✕</button></div>
              ${t.coverId === id ? '<span class="star">COVER</span>' : ''}
            </div>`; }).join('')}</div>
          <div class="tools">${i > 0 ? '<button class="btn line small" data-act="merge">Merge with previous stop</button>' : ''}</div>
        </div>
      </div>`).join('')}`;
}
function mapView() {
  const st = tripStats(S.trip);
  return `<div class="mapwrap"><canvas id="mapC"></canvas></div>
    <div class="stats">
      <div class="stat"><b>${st.days}</b><span>Days</span></div>
      <div class="stat"><b>${st.km.toLocaleString()}</b><span>Km travelled</span></div>
      <div class="stat"><b>${st.places}</b><span>Stops</span></div>
      <div class="stat"><b>${st.photos}</b><span>Photos</span></div>
    </div>`;
}
function drawMapTab() {
  const c = $('#mapC'); if (!c) return;
  const w = c.clientWidth, h = Math.min(Math.max(320, w * 0.6), window.innerHeight * 0.7), dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr; c.style.height = h + 'px';
  const ctx = c.getContext('2d');
  const T = { ...THEMES.minimal, map: '#EAF1F2' };
  drawRouteMap(ctx, 0, 0, c.width, c.height, S.trip, T, dpr * Math.max(1, Math.min(1.4, w / 700)));
}
function bookView() {
  const t = S.trip;
  const seg = (obj, key) => `<div class="seg">${Object.entries(obj).map(([k, v]) => `<button data-set="${key}" data-v="${k}" class="${t[key] === k ? 'on' : ''}">${v.label}${v.sub ? `<small>${v.sub}</small>` : ''}</button>`).join('')}</div>`;
  return `<div class="book-layout">
    <aside class="side">
      <div class="panel">
        <h3>Cover type</h3>${seg(COVERS, 'cover')}
        <h3 style="margin-top:14px">Size</h3>${seg(SIZES, 'size')}
        <h3 style="margin-top:14px">Style</h3>${seg(THEMES, 'theme')}
        <div class="sub" style="margin-top:12px" id="pgCount"></div>
      </div>
      <div class="panel">
        <div class="row" style="flex-direction:column;align-items:stretch;gap:8px">
          <button class="btn primary" data-act="pdf">${ICONS.dl} Export print-ready PDF</button>
          <button class="btn line" data-act="story">${ICONS.wand} Story mode: draft captions</button>
          <button class="btn line" data-act="rebuild">Re-layout all pages</button>
        </div>
      </div>
      <div class="panel" id="pageEditor"><div class="sub">Tap a page to edit its layout and caption.</div></div>
    </aside>
    <section><div class="spreads" id="spreads"></div></section>
  </div>`;
}
function aspect() { const s = SIZES[S.trip.size] || SIZES.square; return s.w / s.h; }
let pageObserver;
function mountBook() {
  const t = S.trip;
  if (!t.pages || !t.pages.length) { t.pages = buildBook(t); saveTrip(); }
  // drop references to deleted photos
  t.pages.forEach(p => { p.photoIds = p.photoIds.filter(id => S.photos.has(id)); });
  const pages = t.pages, ar = aspect();
  $('#pgCount').textContent = `${pages.length} pages · ${SIZES[t.size].sub} · ${COVERS[t.cover].label}`;
  const spreads = [[null, 0]];
  for (let i = 1; i < pages.length; i += 2) spreads.push([i, i + 1 < pages.length ? i + 1 : null]);
  const wrap = $('#spreads');
  wrap.style.setProperty('--spw', ar > 1.1 ? '440px' : ar < 0.9 ? '330px' : '380px');
  wrap.innerHTML = spreads.map((sp, si) => `
    <div class="spread ${t.cover} ${si === 0 ? 'cover-sp' : ''}">
      <div class="pages">${sp.map((pi, k) => pi == null ? `<div class="pg empty" style="aspect-ratio:${ar}"></div>` :
    `<div class="pg ${k ? 'r' : 'l'} ${S.sel === pages[pi].id ? 'sel' : ''}" data-page="${pages[pi].id}" style="aspect-ratio:${ar}"><canvas data-pi="${pi}"></canvas></div>`).join('')}</div>
      <div class="lbl">${si === 0 ? 'Cover' : `Pages ${sp.filter(x => x != null).join('–')}`}</div>
    </div>`).join('');
  if (pageObserver) pageObserver.disconnect();
  pageObserver = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { pageObserver.unobserve(e.target); drawPreview(e.target); } }), { rootMargin: '300px' });
  wrap.querySelectorAll('canvas').forEach(c => pageObserver.observe(c));
  renderEditor();
}
async function drawPreview(c) {
  const pi = +c.dataset.pi, page = S.trip.pages[pi]; if (!page) return;
  const ar = aspect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = (c.parentElement.clientWidth || 200) * dpr;
  c.width = Math.round(cw); c.height = Math.round(cw / ar);
  const ids = page.type === 'cover' || page.type === 'chapter' || page.type === 'photos' ? page.photoIds : [];
  const bm = new Map(await Promise.all(ids.map(async id => [id, await thumbBitmap(id)])));
  renderPage(c.getContext('2d'), c.width, c.height, page, S.trip, id => bm.get(id) || null, page.type === 'photos' || page.type === 'notes' ? pi : 0);
}
function redrawPage(pageId) {
  const el = document.querySelector(`[data-page="${pageId}"] canvas`); if (el) drawPreview(el);
}
function renderEditor() {
  const box = $('#pageEditor'); if (!box) return;
  const t = S.trip, pi = t.pages.findIndex(p => p.id === S.sel), page = t.pages[pi];
  if (!page) { box.innerHTML = '<div class="sub">Tap a page to edit its layout and caption.</div>'; return; }
  const names = { cover: 'Cover', map: 'Route map', chapter: 'Chapter opener', photos: 'Photo page', notes: 'Notes page', end: 'Back page' };
  let html = `<h3>${names[page.type]}${page.type === 'photos' ? ' · page ' + pi : ''}</h3>`;
  if (page.type === 'cover') html += `<div class="field"><label>Title</label><input data-trip="title" value="${esc(t.title)}"></div><div class="field"><label>Subtitle</label><input data-trip="subtitle" value="${esc(subOf(t))}"></div><div class="sub">Pick the cover photo with ★ in the Timeline.</div>`;
  if (page.type === 'chapter') { const ch = t.chapters.find(c => c.id === page.chapterId); if (ch) html += `<div class="field"><label>Stop title</label><input data-ch-f="title" value="${esc(ch.title)}"></div><div class="field"><label>Story</label><textarea data-ch-f="caption" rows="5">${esc(ch.caption)}</textarea></div>`; }
  if (page.type === 'photos') {
    const opts = layoutsFor(page.photoIds.length);
    html += `<div class="lay-opts">${opts.map(k => `<button data-layout="${k}" class="${page.layout === k ? 'on' : ''}" title="${k}">${layoutIcon(k)}</button>`).join('')}</div>
      <div class="field"><label>Caption</label><textarea data-page-cap rows="2" placeholder="Optional caption for this page">${esc(page.caption)}</textarea></div>
      <div class="row"><button class="btn line small" data-act="shuffle">Shuffle photos</button>${page.photoIds.length > 1 ? '<button class="btn line small" data-act="split">Split page</button>' : ''}${t.pages[pi + 1] && t.pages[pi + 1].type === 'photos' && page.photoIds.length + t.pages[pi + 1].photoIds.length <= 4 ? '<button class="btn line small" data-act="join">Join with next</button>' : ''}</div>
      <div class="row" style="margin-top:8px"><button class="btn line small" data-act="move-up">◀ Move</button><button class="btn line small" data-act="move-down">Move ▶</button><button class="btn line small" data-act="del-page">Delete page</button></div>`;
  }
  if (page.type === 'map' || page.type === 'end' || page.type === 'notes') html += `<div class="sub">Generated automatically from your trip.</div>${page.type !== 'end' ? '<div class="row" style="margin-top:8px"><button class="btn line small" data-act="del-page">Delete page</button></div>' : ''}`;
  box.innerHTML = html;
}
function dailyView() {
  const t = S.trip, keys = tripDays(t);
  if (!keys.length) return `<div class="panel empty-note">Set your trip's start and end dates to add photos day by day.<div style="margin-top:12px"><button class="btn primary" data-act="edit-trip">Set trip dates</button></div></div>`;
  const has = S.photos.size;
  return `
    <div class="row" style="justify-content:space-between;margin-bottom:16px">
      <div class="sub">Day-by-day: add the photos for each day. They're placed on that day, even if the photo has no date.</div>
      ${has ? `<div class="row"><button class="btn line small" data-act="story">${ICONS.wand} Write captions</button><button class="btn teal small" data-tab="book">${ICONS.book} Make photo book</button></div>` : ''}
    </div>
    ${keys.map((k, i) => {
      const ch = t.chapters.find(c => c.dayKey === k), d = (t.days || {})[k] || {}, n = dayNum(t, k);
      const inRange = (!t.startDate || k >= t.startDate) && (!t.endDate || k <= t.endDate);
      return `
      <div class="chapter day-card ${ch ? '' : 'empty'}" ${ch ? `data-ch="${ch.id}"` : ''} data-daykey="${k}">
        <div class="rail"><div class="dot">${n}</div>${i < keys.length - 1 ? '<div class="vline"></div>' : ''}</div>
        <div class="body">
          <div class="kicker">Day ${n} · ${fmtDay(k)}${inRange ? '' : ' · outside trip dates'}</div>
          <input class="title" data-df="place" value="${esc(d.place || (ch && ch.title && !/^Day \d+$/.test(ch.title) ? ch.title : ''))}" placeholder="📍 Add a place for day ${n}">
          <textarea data-df="caption" rows="2" placeholder="${d.plan ? 'Plan: ' + esc(d.plan) : 'What happened today? (or let Story mode write it)'}">${esc(ch ? ch.caption : (d.caption || ''))}</textarea>
          ${ch ? `<div class="thumbs">${ch.photoIds.map(id => { const p = S.photos.get(id); if (!p) return ''; return `
            <div class="thumb" data-pid="${id}"><img loading="lazy" src="${thumbURL(p)}" alt="">
              <div class="acts"><button class="ib ${t.coverId === id ? 'on' : ''}" data-act="cover" title="Use as book cover">★</button><span class="row" style="gap:4px"><button class="ib" data-act="move-day" title="Move to another day">⇄</button><button class="ib" data-act="del-photo" title="Remove from trip">✕</button></span></div>
              ${t.coverId === id ? '<span class="star">COVER</span>' : ''}
            </div>`; }).join('')}</div>` : ''}
          <div class="tools" style="justify-content:flex-start"><button class="btn ${ch ? 'line' : 'primary'} small" data-act="add-day" data-day="${k}">${ICONS.plus} ${ch ? 'Add more photos' : `Add photos for day ${n}`}</button>${ch ? `<span class="sub" style="align-self:center">${ch.photoIds.length} photo${ch.photoIds.length > 1 ? 's' : ''}</span>` : ''}</div>
        </div>
      </div>`; }).join('')}`;
}
function tripForm(t = {}, isNew = true) {
  return new Promise(res => {
    const mode = t.uploadMode || 'whole';
    const m = modal(`<h2>${isNew ? 'New trip' : 'Trip details'}</h2>
      <form id="tripF" class="trip-form">
        <div class="field"><label>Trip name *</label><input name="title" required maxlength="80" value="${esc(t.title || '')}" placeholder="e.g. Salzburg family holiday"></div>
        <div class="field"><label>Destination</label><input name="destination" maxlength="80" value="${esc(t.destination || '')}" placeholder="City, country — e.g. Salzburg, Austria"></div>
        <div class="two">
          <div class="field"><label>From</label><input type="date" name="startDate" value="${esc(t.startDate || '')}"></div>
          <div class="field"><label>To</label><input type="date" name="endDate" value="${esc(t.endDate || '')}"></div>
        </div>
        <div class="two">
          <div class="field"><label>Travelling with</label><input name="travellers" maxlength="60" value="${esc(t.travellers || '')}" placeholder="e.g. Kamil & family"></div>
          <div class="field"><label>Trip type</label><select name="tripType"><option value="">—</option>${TRIP_TYPES.map(x => `<option ${t.tripType === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>Notes</label><textarea name="notes" rows="2" maxlength="500" placeholder="Hotel, flight, highlights… (optional)">${esc(t.notes || '')}</textarea></div>
        <div class="field"><label>How do you want to add photos?</label>
          <div class="mode-opts">
            <label class="mode ${mode === 'whole' ? 'on' : ''}"><input type="radio" name="uploadMode" value="whole" ${mode === 'whole' ? 'checked' : ''}><b>📷 Whole trip at once</b><small>Pick all photos together. Grouped by their date & GPS.</small></label>
            <label class="mode ${mode === 'daily' ? 'on' : ''}"><input type="radio" name="uploadMode" value="daily" ${mode === 'daily' ? 'checked' : ''}><b>📅 Day by day</b><small>Add photos for Day 1, Day 2… Best when photos have no date.</small></label>
          </div>
        </div>
        <div class="err sub" style="color:#b3361b;min-height:18px"></div>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn line" data-a="no">Cancel</button><button type="submit" class="btn primary">${isNew ? 'Create trip' : 'Save'}</button></div>
      </form>`);
    const f = $('#tripF', m.el);
    if (isNew) setTimeout(() => f.elements.title.focus(), 50);
    f.addEventListener('change', e => { if (e.target.name === 'uploadMode') f.querySelectorAll('.mode').forEach(x => x.classList.toggle('on', x.contains(e.target))); const E = f.elements; if (e.target.name === 'startDate' && E.endDate.value && E.endDate.value < E.startDate.value) E.endDate.value = E.startDate.value; if (e.target.name === 'startDate') E.endDate.min = E.startDate.value; });
    f.addEventListener('submit', e => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f).entries());
      Object.keys(v).forEach(k => v[k] = String(v[k]).trim());
      if (!v.title) { $('.err', m.el).textContent = 'Please give your trip a name.'; return; }
      if (v.startDate && v.endDate && v.endDate < v.startDate) [v.startDate, v.endDate] = [v.endDate, v.startDate];
      if (v.startDate && !v.endDate) v.endDate = v.startDate;
      if (v.startDate && (parseYmd(v.endDate) - parseYmd(v.startDate)) / 864e5 > 90) { $('.err', m.el).textContent = 'Trips can be up to 90 days long.'; return; }
      if (v.uploadMode === 'daily' && !v.startDate) { $('.err', m.el).textContent = 'Day-by-day needs the trip dates (From / To).'; return; }
      m.close(); res(v);
    });
    m.el.addEventListener('click', e => { if (e.target.dataset.a === 'no' || e.target === m.el) { m.close(); res(null); } });
  });
}
async function editTripDetails() {
  const t = S.trip, before = JSON.stringify([t.startDate, t.endDate, t.uploadMode, t.destination]);
  const v = await tripForm(t, false); if (!v) return;
  Object.assign(t, v);
  if (S.photos.size && before !== JSON.stringify([t.startDate, t.endDate, t.uploadMode, t.destination])) { regroup(); if (t.autoStory !== false) autoCaptions(); }
  saveTrip(true); render(); toast('Trip details saved');
}
let pendingDay = null;
function pickDayThenUpload() {
  const t = S.trip, keys = tripDays(t);
  const m = modal(`<h2>Add photos to…</h2><div class="day-pick">${keys.map(k => { const ch = t.chapters.find(c => c.dayKey === k), d = (t.days || {})[k] || {}; return `<button data-k="${k}"><b>Day ${dayNum(t, k)}</b><span>${fmtDay(k)}${d.place ? ' · ' + esc(d.place) : ''}</span><small>${ch ? ch.photoIds.length + (ch.photoIds.length > 1 ? ' photos' : ' photo') : 'empty'}</small></button>`; }).join('')}
    <button data-k="auto"><b>Use photo dates</b><span>Sort by each photo's own date</span><small></small></button></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn line" data-a="no">Cancel</button></div>`);
  m.el.addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) { pendingDay = b.dataset.k === 'auto' ? null : b.dataset.k; m.close(); $('#fileIn').click(); } else if (e.target.dataset.a || e.target === m.el) m.close(); });
}
function settingsView() {
  const t = S.trip;
  const info = [['Destination', t.destination], ['Dates', t.startDate ? fmtRange(parseYmd(t.startDate), parseYmd(t.endDate || t.startDate)) : ''], ['Travelling with', t.travellers], ['Trip type', t.tripType], ['Photos added', t.uploadMode === 'daily' ? 'Day by day' : 'Whole trip at once'], ['Notes', t.notes]];
  return `<div class="panel" style="max-width:560px;margin-bottom:16px">
    <div class="row" style="justify-content:space-between"><h2>Trip details</h2><button class="btn teal small" data-act="edit-trip">✎ Edit details</button></div>
    <dl class="info">${info.map(([k, v]) => `<dt>${k}</dt><dd>${v ? esc(v) : '<span class="sub">—</span>'}</dd>`).join('')}</dl>
  </div>
  <div class="panel" style="max-width:560px">
    <div class="field"><label>Trip name</label><input data-trip="title" value="${esc(t.title)}"></div>
    <div class="field"><label>Subtitle (shown on cover)</label><input data-trip="subtitle" value="${esc(t.subtitleEdited ? t.subtitle : '')}" placeholder="${esc(defaultSubtitle(t) || 'Dates are filled in automatically')}"></div>
    <label class="row" style="margin:4px 0 14px;gap:8px;cursor:pointer"><input type="checkbox" data-toggle="autoStory" ${t.autoStory !== false ? 'checked' : ''}> Auto-write story & offer music when adding photos</label>
    <div class="row" style="margin-top:8px"><button class="btn line" data-act="regroup">Re-group timeline from photos</button><button class="btn line" data-act="del-trip" style="color:#b3361b">Delete trip</button></div>
    <p class="sub" style="margin-top:16px;line-height:1.5">Photos are stored only on this device. Re-grouping rebuilds stops from photo dates & GPS and keeps titles/captions you've edited where it can.</p>
  </div>`;
}

const APP_VERSION = '1.3.0';
function showAbout() {
  const logo = $('#homeBtn svg').outerHTML.replace('<svg', '<svg style="width:72px;height:72px"');
  const m = modal(`<div style="text-align:center">${logo}
    <h2 style="margin:10px 0 2px">MeyJournal</h2><div class="sub">Version ${APP_VERSION}</div>
    <p style="line-height:1.55;margin:14px 0">Turn your trip photos into a story with music, a route map and a print-ready photo book.</p>
    <div class="about-owner"><span class="sub">Created & owned by</span><b>Kamil</b></div>
    <p class="sub" style="line-height:1.5;margin-top:14px">Your photos stay on this device — nothing is uploaded.<br>© ${new Date().getFullYear()} Kamil. All rights reserved.</p>
    <button class="btn primary" data-a="ok" style="margin-top:6px">Close</button></div>`);
  m.el.addEventListener('click', e => { if (e.target.dataset.a || e.target === m.el) m.close(); });
}

/* ---------------- Actions ---------------- */
async function newTrip(title, opts = {}) {
  const t = { id: uid(), title: title || 'My trip', subtitle: '', createdAt: Date.now(), updatedAt: Date.now(), chapters: [], pages: null, cover: 'hardcover', size: 'square', theme: 'classic', coverId: null, count: 0, music: 'calm', autoStory: true, uploadMode: 'whole', days: {}, destination: '', startDate: '', endDate: '', travellers: '', tripType: '', notes: '', ...opts };
  await DB.put('trips', t);
  await openTrip(t.id);
}
async function importFiles(fileList, day = null) {
  if (!S.trip) return;
  let files = [...fileList].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(f.name));
  if (!files.length) { toast('No images found in that selection'); return; }
  const room = MAX_PHOTOS - S.photos.size;
  if (room <= 0) { toast(`This trip already has ${MAX_PHOTOS} photos (the maximum)`); return; }
  if (files.length > room) { toast(`Only the first ${room} photos were added (max ${MAX_PHOTOS} per trip)`); files = files.slice(0, room); }
  const pg = progress(`Importing ${files.length} photo${files.length > 1 ? 's' : ''}${day ? ' for day ' + dayNum(S.trip, day) : ''}`);
  let done = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < files.length) {
      const idx = i, f = files[i++];
      try {
        const p = await processFile(f, S.trip.id, day, idx);
        await DB.put('photos', p); S.photos.set(p.id, p);
      } catch (e) { failed++; }
      done++; pg.set(done / files.length, `${done} / ${files.length} processed${failed ? ` · ${failed} skipped` : ''}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  pg.set(1, 'Writing your story…'); await sleep(150);
  regroup();
  if (S.trip.autoStory !== false) autoCaptions();
  saveTrip(true);
  pg.close();
  render();
  if (failed) toast(`${failed} file${failed > 1 ? 's' : ''} couldn't be read (HEIC/RAW? export as JPEG)`);
  if (done - failed > 0 && S.trip.autoStory !== false && window.Story) Story.offer(done - failed);
}
function regroup() {
  const t = S.trip;
  t.chapters = autoGroup([...S.photos.values()], t.chapters, t);
  if (!t.coverId || !S.photos.has(t.coverId)) t.coverId = t.chapters[0]?.photoIds[0] || null;
  t.count = S.photos.size; t.pages = null;
  saveTrip(true);
}
function storyMode() {
  const t = S.trip, n = t.chapters.length;
  t.chapters.forEach((ch, i) => { if (!ch.edited || !ch.caption) ch.caption = storyCaption(ch, i, n); });
  saveTrip(); toast('Draft captions written — edit any of them');
  render();
}
function autoCaptions() {
  const t = S.trip, n = t.chapters.length;
  t.chapters.forEach((ch, i) => { if (!ch.edited) ch.caption = storyCaption(ch, i, n); });
}
async function exportPDF() {
  if (!window.PDFLib) { toast('PDF engine missing'); return; }
  const t = S.trip; if (!t.pages) t.pages = buildBook(t);
  const sz = SIZES[t.size], DPI = 200;
  const W = Math.round(sz.w * DPI), H = Math.round(sz.h * DPI);
  const pg = progress('Creating your photo book PDF');
  try {
    const doc = await PDFLib.PDFDocument.create();
    doc.setTitle(t.title || 'Photo book'); doc.setCreator('MeyJournal'); doc.setProducer('MeyJournal');
    const c = mkCanvas(W, H), ctx = c.getContext('2d');
    for (let i = 0; i < t.pages.length; i++) {
      const page = t.pages[i];
      const bm = new Map();
      for (const id of page.photoIds) { const p = S.photos.get(id); if (p) bm.set(id, await createImageBitmap(p.blob).catch(() => null)); }
      renderPage(ctx, W, H, page, t, id => bm.get(id) || null, page.type === 'photos' || page.type === 'notes' ? i : 0);
      bm.forEach(b => b && b.close && b.close());
      const jpg = await (await toBlob(c, 'image/jpeg', 0.9)).arrayBuffer();
      const img = await doc.embedJpg(jpg);
      const pp = doc.addPage([sz.w * 72, sz.h * 72]);
      pp.drawImage(img, { x: 0, y: 0, width: sz.w * 72, height: sz.h * 72 });
      pg.set((i + 1) / t.pages.length, `Page ${i + 1} of ${t.pages.length}`);
      await sleep(0);
    }
    const bytes = await doc.save();
    pg.close();
    const name = `${(t.title || 'photo-book').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-')}-${t.cover}-${t.size}.pdf`;
    await Platform.saveFile(new Blob([bytes], { type: 'application/pdf' }), name);
  } catch (e) { pg.close(); console.error(e); toast('Export failed: ' + e.message); }
}

/* ---------------- Trip templates & sample trips ---------------- */
// kind = what the painted sample photos look like
const TEMPLATES = [
  { id: 'my', emoji: '🇲🇾', title: 'Malaysia Road Trip', destination: 'Malaysia', tripType: 'Road trip', grad: ['#ffb37a', '#ff7a59'], days: [
    { place: 'Melaka', lat: 2.195, lon: 102.249, kind: 'city', plan: 'Jonker Street, Stadthuys and a river cruise at dusk.' },
    { place: 'Kuala Lumpur', lat: 3.141, lon: 101.69, kind: 'towers', plan: 'Petronas Towers, Batu Caves and street food in Jalan Alor.' },
    { place: 'Cameron Highlands', lat: 4.47, lon: 101.38, kind: 'hills', plan: 'Tea plantations, strawberry farms and cool mountain air.' },
    { place: 'George Town', lat: 5.414, lon: 100.33, kind: 'city', plan: 'Street art, clan jetties and char kway teow.' },
    { place: 'Langkawi', lat: 6.35, lon: 99.8, kind: 'beach', plan: 'Cable car, SkyBridge and sunset at Pantai Cenang.' }] },
  { id: 'salzburg', emoji: '🏔️', title: 'Salzburg & the Alps', destination: 'Salzburg, Austria', tripType: 'Family', grad: ['#9cc9ff', '#4b7bd1'], days: [
    { place: 'Salzburg Old Town', lat: 47.80, lon: 13.045, kind: 'city', plan: 'Arrive, walk Getreidegasse and Mozart’s birthplace.' },
    { place: 'Hohensalzburg Fortress', lat: 47.795, lon: 13.047, kind: 'castle', plan: 'Funicular up to the fortress, views over the city.' },
    { place: 'Hallstatt', lat: 47.562, lon: 13.649, kind: 'lake', plan: 'Lakeside village, boat ride and the skywalk.' },
    { place: 'Untersberg', lat: 47.72, lon: 13.0, kind: 'mountain', plan: 'Cable car to the snowy peak.' },
    { place: 'Mirabell Gardens', lat: 47.806, lon: 13.042, kind: 'garden', plan: 'Gardens, last souvenirs and apple strudel.' }] },
  { id: 'umrah', emoji: '🕋', title: 'Umrah Journey', destination: 'Makkah & Madinah', tripType: 'Umrah', grad: ['#d9c49a', '#7a6a4f'], days: [
    { place: 'Madinah', lat: 24.467, lon: 39.611, kind: 'mosque', plan: 'Arrive in Madinah, first prayers at Masjid an-Nabawi.' },
    { place: 'Madinah', lat: 24.467, lon: 39.611, kind: 'mosque', plan: 'Ziarah: Quba Mosque and Mount Uhud.' },
    { place: 'Madinah', lat: 24.467, lon: 39.611, kind: 'mosque', plan: 'Quiet day of ibadah and dates market.' },
    { place: 'Makkah', lat: 21.4225, lon: 39.826, kind: 'mosque', plan: 'Travel to Makkah and perform Umrah.' },
    { place: 'Makkah', lat: 21.4225, lon: 39.826, kind: 'mosque', plan: 'Prayers at Masjidil Haram.' },
    { place: 'Makkah', lat: 21.4225, lon: 39.826, kind: 'mosque', plan: 'Ziarah: Jabal Rahmah, Arafah and Mina.' },
    { place: 'Jeddah', lat: 21.543, lon: 39.172, kind: 'beach', plan: 'Corniche walk and the floating mosque before flying home.' }] },
  { id: 'japan', emoji: '🗾', title: 'Japan Highlights', destination: 'Japan', tripType: 'Holiday', grad: ['#ffc6d9', '#d9577f'], days: [
    { place: 'Tokyo', lat: 35.68, lon: 139.76, kind: 'towers', plan: 'Shibuya crossing, Shinjuku lights.' },
    { place: 'Tokyo', lat: 35.71, lon: 139.8, kind: 'temple', plan: 'Asakusa, Senso-ji and Tokyo Skytree.' },
    { place: 'Mount Fuji', lat: 35.36, lon: 138.73, kind: 'mountain', plan: 'Lake Kawaguchiko and Fuji views.' },
    { place: 'Kyoto', lat: 35.01, lon: 135.77, kind: 'temple', plan: 'Fushimi Inari gates and Gion at night.' },
    { place: 'Kyoto', lat: 35.02, lon: 135.67, kind: 'garden', plan: 'Arashiyama bamboo grove.' },
    { place: 'Nara', lat: 34.69, lon: 135.8, kind: 'temple', plan: 'Deer park and Todai-ji.' },
    { place: 'Osaka', lat: 34.69, lon: 135.5, kind: 'city', plan: 'Dotonbori street food and the castle.' }] },
  { id: 'bali', emoji: '🌴', title: 'Bali Island Escape', destination: 'Bali, Indonesia', tripType: 'Honeymoon', grad: ['#7fe0d4', '#159a8c'], days: [
    { place: 'Ubud', lat: -8.507, lon: 115.263, kind: 'hills', plan: 'Tegallalang rice terraces and swings.' },
    { place: 'Ubud', lat: -8.519, lon: 115.26, kind: 'temple', plan: 'Monkey forest and a Balinese cooking class.' },
    { place: 'Nusa Penida', lat: -8.727, lon: 115.544, kind: 'beach', plan: 'Kelingking beach and snorkelling.' },
    { place: 'Uluwatu', lat: -8.829, lon: 115.085, kind: 'beach', plan: 'Cliff temple and kecak dance at sunset.' },
    { place: 'Seminyak', lat: -8.69, lon: 115.17, kind: 'beach', plan: 'Beach clubs and last swim.' }] },
  { id: 'langkawi', emoji: '🏝️', title: 'Langkawi Family Weekend', destination: 'Langkawi, Malaysia', tripType: 'Family', grad: ['#5ec4e0', '#1f7fa6'], days: [
    { place: 'Pantai Cenang', lat: 6.29, lon: 99.73, kind: 'beach', plan: 'Check in, beach and sunset dinner.' },
    { place: 'SkyBridge', lat: 6.386, lon: 99.663, kind: 'mountain', plan: 'Cable car, SkyBridge and the eagle square.' },
    { place: 'Kilim Geoforest', lat: 6.41, lon: 99.86, kind: 'lake', plan: 'Mangrove boat tour, then fly home.' }] },
  { id: 'turkey', emoji: '🎈', title: 'Istanbul & Cappadocia', destination: 'Türkiye', tripType: 'Holiday', grad: ['#ffd27a', '#c76b3a'], days: [
    { place: 'Istanbul', lat: 41.008, lon: 28.978, kind: 'mosque', plan: 'Blue Mosque, Hagia Sophia and the Grand Bazaar.' },
    { place: 'Istanbul', lat: 41.04, lon: 29.0, kind: 'city', plan: 'Bosphorus cruise and Galata Tower.' },
    { place: 'Cappadocia', lat: 38.64, lon: 34.83, kind: 'balloon', plan: 'Sunrise hot-air balloons.' },
    { place: 'Cappadocia', lat: 38.66, lon: 34.85, kind: 'hills', plan: 'Fairy chimneys and the underground city.' },
    { place: 'Istanbul', lat: 41.01, lon: 28.97, kind: 'city', plan: 'Last çay and baklava before flying home.' }] }
];

/** Make a day-by-day plan for any destination (offline): uses the built-in city list for nearby day trips. */
function generateTemplate(dest, nDays, tripType) {
  nDays = Math.max(1, Math.min(30, nDays | 0));
  const q = dest.toLowerCase().split(',')[0].trim();
  const base = CITIES.find(c => c.name.toLowerCase() === q) || CITIES.find(c => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()) || c.country.toLowerCase() === q);
  const name = base ? base.name : dest.split(',')[0].trim() || 'My destination';
  const near = base ? CITIES.filter(c => c !== base && km(c, base) < 350).sort((a, b) => km(a, base) - km(b, base)).slice(0, 4) : [];
  const fam = /family/i.test(tripType || ''), kinds = ['city', 'garden', 'hills', 'lake', 'beach', 'temple', 'mountain'];
  const ideas = [
    `Explore ${name}: the old town, main square and local market.`,
    `Museums, cafés and a slow lunch in ${name}.`,
    fam ? `A playground, park or zoo day for the kids in ${name}.` : `Hidden corners of ${name} and a sunset viewpoint.`,
    `Food tour: try ${name}'s best local dishes.`,
    `Nature day outside ${name}: hike, lake or beach.`,
    `Free day — shopping and souvenirs in ${name}.`
  ];
  const days = [];
  for (let i = 0; i < nDays; i++) {
    const p = base || { lat: null, lon: null };
    if (i === 0) days.push({ place: name, lat: p.lat, lon: p.lon, kind: 'city', plan: `Arrive in ${name}, check in and take a first walk around.` });
    else if (i === nDays - 1 && nDays > 1) days.push({ place: name, lat: p.lat, lon: p.lon, kind: 'garden', plan: `Last breakfast in ${name}, final photos and head home.` });
    else if (near.length && i % 3 === 2) { const n = near[(Math.floor(i / 3)) % near.length]; days.push({ place: n.name, lat: n.lat, lon: n.lon, kind: kinds[i % kinds.length], plan: `Day trip to ${n.name}.` }); }
    else days.push({ place: name, lat: p.lat, lon: p.lon, kind: kinds[i % kinds.length], plan: ideas[(i - 1) % ideas.length] });
  }
  return { id: 'gen', emoji: '✨', title: `${name} in ${nDays} day${nDays > 1 ? 's' : ''}`, destination: base ? `${base.name}, ${base.country}` : dest, tripType: tripType || 'Holiday', grad: ['#c9b8ff', '#6a4fd1'], days };
}

function templatesSection() {
  return `<h2 style="margin-top:30px">Start from a template</h2>
    <div class="sub">See a full sample trip with story & photo book, or use one as the day-by-day plan for your own trip.</div>
    <div class="tpl-grid">
      <button class="tpl gen" data-act="tpl-gen"><span class="em">✨</span><b>Generate a plan</b><small>Any destination, any number of days</small></button>
      ${TEMPLATES.map(t => `<button class="tpl" data-tpl="${t.id}" style="--g1:${t.grad[0]};--g2:${t.grad[1]}"><span class="em">${t.emoji}</span><b>${esc(t.title)}</b><small>${t.days.length} days · ${esc(t.tripType)}</small></button>`).join('')}
    </div>`;
}
function showTemplate(tp) {
  const m = modal(`<div class="tpl-head" style="--g1:${tp.grad[0]};--g2:${tp.grad[1]}"><span class="em">${tp.emoji}</span><div><h2 style="margin:0">${esc(tp.title)}</h2><div>${esc(tp.destination)} · ${tp.days.length} days · ${esc(tp.tripType)}</div></div></div>
    <ol class="tpl-days">${tp.days.map(d => `<li><b>${esc(d.place)}</b><span>${esc(d.plan)}</span></li>`).join('')}</ol>
    <div class="field"><label>Start date (for “Use for my trip”)</label><input type="date" id="tplStart" value="${ymd(Date.now() + 30 * 864e5)}"></div>
    <div class="row" style="justify-content:space-between;gap:8px">
      <button class="btn line" data-a="no">Close</button>
      <span class="row" style="gap:8px"><button class="btn line" data-a="sample">▶ See sample</button><button class="btn primary" data-a="use">Use for my trip</button></span>
    </div>`);
  m.el.addEventListener('click', async e => {
    const a = e.target.closest('[data-a]');
    if (!a && e.target !== m.el) return;
    const act = a ? a.dataset.a : 'no', start = $('#tplStart', m.el).value;
    m.close();
    if (act === 'sample') sampleTrip(tp);
    if (act === 'use') useTemplate(tp, start || ymd(Date.now()));
  });
}
function addDays(key, n) { const d = new Date(parseYmd(key)); d.setDate(d.getDate() + n); return ymd(d.getTime()); }
async function useTemplate(tp, start) {
  const days = {};
  tp.days.forEach((d, i) => { days[addDays(start, i)] = { place: d.place, plan: d.plan }; });
  await newTrip(tp.title, { destination: tp.destination, tripType: tp.tripType, startDate: start, endDate: addDays(start, tp.days.length - 1), uploadMode: 'daily', days, fromTemplate: tp.id });
  toast('Plan ready — add your photos to each day');
}
/** Full sample trip with painted photos, captions, story and book — nothing needs the network. */
async function sampleTrip(tp) {
  const start = '2026-08-10';
  const days = {};
  tp.days.forEach((d, i) => { days[addDays(start, i)] = { place: d.place, plan: d.plan }; });
  await newTrip(tp.title + ' (sample)', { destination: tp.destination, tripType: tp.tripType, travellers: tp.tripType === 'Family' ? 'the family' : '', startDate: start, endDate: addDays(start, tp.days.length - 1), uploadMode: 'daily', days, sample: true });
  const per = tp.days.length > 5 ? 4 : 6, total = per * tp.days.length;
  const pg = progress('Creating sample photos');
  let made = 0;
  for (let s = 0; s < tp.days.length; s++) {
    const st = tp.days[s], key = addDays(start, s);
    for (let k = 0; k < per; k++) {
      const portrait = k % 4 === 2, w = portrait ? 900 : 1200, h = portrait ? 1200 : 900;
      const c = mkCanvas(w, h), x = c.getContext('2d');
      paintScene(x, w, h, st, k + s);
      const blob = await toBlob(c, 'image/jpeg', 0.85);
      const thumb = await resizeTo(c, 520, 0.8);
      const j = () => (Math.random() - .5) * 0.02;
      const p = { id: uid(), tripId: S.trip.id, name: `sample-${s}-${k}.jpg`, blob, thumb: thumb.blob, w, h, time: parseYmd(key) + (8.5 + k * 1.4) * 3600e3, exifTime: true, day: key, lat: st.lat != null ? st.lat + j() : null, lon: st.lon != null ? st.lon + j() : null };
      await DB.put('photos', p); S.photos.set(p.id, p);
      pg.set(++made / total);
    }
  }
  regroup(); autoCaptions(); saveTrip(true);
  pg.close();
  S.tab = 'timeline'; render();
  if (window.Story) Story.offer(made);
}
async function demoTrip() { return sampleTrip(TEMPLATES[0]); }
async function genTemplateForm() {
  const m = modal(`<h2>✨ Generate a trip plan</h2>
    <form id="genF"><div class="field"><label>Destination</label><input name="dest" required placeholder="e.g. Tokyo, Paris, Penang, Salzburg"></div>
    <div class="two"><div class="field"><label>Days</label><input name="n" type="number" min="1" max="30" value="5"></div>
    <div class="field"><label>Trip type</label><select name="type">${TRIP_TYPES.map(x => `<option>${x}</option>`).join('')}</select></div></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn line" data-a="no">Cancel</button><button class="btn primary">Generate</button></div></form>`);
  const f = $('#genF', m.el); setTimeout(() => f.elements.dest.focus(), 50);
  f.addEventListener('submit', e => { e.preventDefault(); const E = f.elements; if (!E.dest.value.trim()) return; m.close(); showTemplate(generateTemplate(E.dest.value.trim(), +E.n.value || 5, E.type.value)); });
  m.el.addEventListener('click', e => { if (e.target.dataset.a === 'no' || e.target === m.el) m.close(); });
}
function paintScene(x, w, h, st, k) {
  const r = (a, b) => a + Math.random() * (b - a);
  const SKY = { city: ['#ffb37a', '#ffe1c2'], towers: ['#7ec8ff', '#d8f0ff'], hills: ['#cfe8d5', '#f2f7f0'], beach: ['#5ec4e0', '#c2f0ff'], mountain: ['#8fb8ef', '#e6f0ff'], lake: ['#9fd3f5', '#eaf6ff'], temple: ['#ffd1dc', '#fff0e8'], mosque: ['#f6d79a', '#fff4dc'], garden: ['#bfe3a8', '#f4fbe9'], castle: ['#a9c8f2', '#edf4ff'], balloon: ['#ffb38a', '#ffe7c7'] };
  const kind = st.kind || 'city', sky = SKY[kind] || SKY.city, evening = k % 5 === 4;
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, evening ? '#3d3a6b' : sky[0]); g.addColorStop(1, evening ? '#ff9a6a' : sky[1]);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.fillStyle = evening ? 'rgba(255,230,180,.9)' : 'rgba(255,255,255,.85)'; x.beginPath(); x.arc(r(.15, .85) * w, r(.12, .3) * h, r(30, 70), 0, 7); x.fill();
  const gy = h * r(.6, .72);
  const hills = (cols, base) => cols.forEach((col, l) => { x.fillStyle = col; x.beginPath(); x.moveTo(0, h); for (let i = 0; i <= 12; i++) x.lineTo(i / 12 * w, base + l * 45 - Math.sin(i * .8 + k + l * 2) * 50 - 40); x.lineTo(w, h); x.fill(); });
  if (kind === 'hills' || kind === 'garden') {
    hills(['#6fae7c', '#4f9a5f', '#3e7d4d'], gy - 80);
    if (kind === 'garden') for (let i = 0; i < 30; i++) { x.fillStyle = ['#ff6f91', '#ffd166', '#f78c6b', '#ffffff'][i % 4]; x.beginPath(); x.arc(r(0, w), r(gy + 40, h), r(6, 14), 0, 7); x.fill(); }
  } else if (kind === 'mountain') {
    for (let l = 0; l < 2; l++) { x.fillStyle = l ? '#5a6f8f' : '#7f93b3'; x.beginPath(); x.moveTo(0, h); const pk = r(.3, .7) * w; x.lineTo(pk - w * .5, gy + 40); x.lineTo(pk, gy - 330 + l * 90); x.lineTo(pk + w * .5, gy + 40); x.lineTo(w, h); x.fill(); x.fillStyle = '#fff'; x.beginPath(); x.moveTo(pk - 70, gy - 330 + l * 90 + 90); x.lineTo(pk, gy - 330 + l * 90); x.lineTo(pk + 70, gy - 330 + l * 90 + 90); x.fill(); }
    x.fillStyle = '#3e6b4a'; x.fillRect(0, gy + 40, w, h);
  } else if (kind === 'lake') {
    hills(['#5f7f6a', '#4a6b57'], gy - 120);
    x.fillStyle = '#4fa3c7'; x.fillRect(0, gy, w, h); x.fillStyle = 'rgba(255,255,255,.35)'; for (let i = 0; i < 12; i++) x.fillRect(r(0, w), r(gy + 10, h), r(40, 120), 3);
    for (let i = 0; i < 6; i++) { const bx = w * .15 + i * 70, bh = r(50, 90); x.fillStyle = ['#f2e3c6', '#e9b44c', '#d96c4f'][i % 3]; x.fillRect(bx, gy - bh, 55, bh); x.fillStyle = '#7a3b2e'; x.beginPath(); x.moveTo(bx - 6, gy - bh); x.lineTo(bx + 27, gy - bh - 30); x.lineTo(bx + 61, gy - bh); x.fill(); }
  } else if (kind === 'beach') {
    x.fillStyle = '#1aa3c9'; x.fillRect(0, gy - 60, w, 140); x.fillStyle = '#e9d4a3'; x.fillRect(0, gy + 60, w, h);
    x.strokeStyle = '#2f5d34'; x.lineWidth = 12; const px = r(.2, .8) * w; x.beginPath(); x.moveTo(px, gy + 120); x.quadraticCurveTo(px + 30, gy - 80, px + 10, gy - 200); x.stroke();
    x.fillStyle = '#3f8a46'; for (let i = 0; i < 6; i++) { x.beginPath(); x.ellipse(px + 10, gy - 200, 110, 22, i * .55, 0, 7); x.fill(); }
  } else if (kind === 'towers') {
    x.fillStyle = '#40525c'; for (let i = 0; i < 14; i++) { const bw = r(50, 110), bh = r(120, 320); x.fillRect(i / 14 * w, gy - bh, bw, bh + h); }
    x.fillStyle = '#c9d3da'; [.42, .55].forEach(f => { x.fillRect(f * w, gy - 520, 46, 520); x.beginPath(); x.moveTo(f * w, gy - 520); x.lineTo(f * w + 23, gy - 600); x.lineTo(f * w + 46, gy - 520); x.fill(); });
  } else if (kind === 'temple') {
    hills(['#8bb08a'], gy - 40);
    const cx = r(.35, .65) * w; x.fillStyle = '#b8323a';
    for (let l = 0; l < 4; l++) { const yy = gy - 60 - l * 90, ww = 260 - l * 40; x.fillRect(cx - ww / 2 + 30, yy - 50, ww - 60, 50); x.beginPath(); x.moveTo(cx - ww / 2 - 20, yy - 50); x.lineTo(cx, yy - 95); x.lineTo(cx + ww / 2 + 20, yy - 50); x.fill(); }
    x.fillStyle = '#d9473f'; x.fillRect(w * .08, gy - 150, 18, 160); x.fillRect(w * .08 + 120, gy - 150, 18, 160); x.fillRect(w * .08 - 20, gy - 160, 180, 18);
  } else if (kind === 'mosque') {
    x.fillStyle = '#efe4cc'; x.fillRect(0, gy - 40, w, h);
    const cx = r(.4, .6) * w; x.fillStyle = '#f7f1e3'; x.fillRect(cx - 200, gy - 160, 400, 160);
    x.beginPath(); x.arc(cx, gy - 160, 110, Math.PI, 0); x.fill(); x.fillStyle = '#4e8a6e'; x.beginPath(); x.arc(cx, gy - 168, 100, Math.PI, 0); x.fill();
    [cx - 300, cx + 280].forEach(mx => { x.fillStyle = '#f7f1e3'; x.fillRect(mx, gy - 420, 26, 420); x.fillStyle = '#4e8a6e'; x.beginPath(); x.moveTo(mx - 4, gy - 420); x.lineTo(mx + 13, gy - 480); x.lineTo(mx + 30, gy - 420); x.fill(); });
    x.fillStyle = 'rgba(0,0,0,.18)'; for (let i = 0; i < 6; i++) { x.beginPath(); x.arc(cx - 150 + i * 60, gy - 60, 18, Math.PI, 0); x.fill(); x.fillRect(cx - 168 + i * 60, gy - 60, 36, 50); }
  } else if (kind === 'castle') {
    hills(['#6c9a6e', '#557f58'], gy - 60);
    const cx = r(.35, .6) * w; x.fillStyle = '#e8e2d4'; x.fillRect(cx - 180, gy - 300, 360, 140);
    for (let i = 0; i < 9; i++) x.fillRect(cx - 180 + i * 42, gy - 320, 24, 24); x.fillRect(cx + 100, gy - 400, 70, 240); x.fillStyle = '#b54a3a'; x.beginPath(); x.moveTo(cx + 92, gy - 400); x.lineTo(cx + 135, gy - 470); x.lineTo(cx + 178, gy - 400); x.fill();
  } else if (kind === 'balloon') {
    hills(['#d89a6a', '#c27f52'], gy - 40);
    for (let i = 0; i < 7; i++) { const bx = r(.05, .95) * w, by = r(.12, .55) * h, s = r(.4, 1); x.fillStyle = ['#e63946', '#ffb703', '#219ebc', '#8ac926', '#ff6f91'][i % 5]; x.beginPath(); x.ellipse(bx, by, 50 * s, 62 * s, 0, 0, 7); x.fill(); x.fillStyle = '#6b4226'; x.fillRect(bx - 10 * s, by + 72 * s, 20 * s, 16 * s); }
  } else {
    for (let i = 0; i < 9; i++) { const bw = r(90, 160), bh = r(90, 220), bx = i / 9 * w; x.fillStyle = ['#d96c4f', '#e9b44c', '#f2e3c6', '#b8553f'][i % 4]; x.fillRect(bx, gy - bh, bw, bh + h); x.fillStyle = 'rgba(0,0,0,.18)'; for (let wy = gy - bh + 20; wy < gy - 20; wy += 40) for (let wx = bx + 14; wx < bx + bw - 20; wx += 34) x.fillRect(wx, wy, 16, 22); }
  }
  x.fillStyle = 'rgba(0,0,0,.12)'; x.fillRect(0, h - 40, w, 40);
}

/* ---------------- Events ---------------- */
document.addEventListener('click', async e => {
  const tplEl = e.target.closest('[data-tpl]');
  if (tplEl) { showTemplate(TEMPLATES.find(x => x.id === tplEl.dataset.tpl)); return; }
  const el = e.target.closest('[data-act],[data-tab],[data-open],[data-set],[data-page],[data-layout]');
  if (!el) return;
  if (el.dataset.tab) { S.tab = el.dataset.tab; S.sel = null; render(); window.scrollTo(0, 0); return; }
  if (el.dataset.open) { openTrip(el.dataset.open); return; }
  if (el.dataset.set) { S.trip[el.dataset.set] = el.dataset.v; if (el.dataset.set === 'size') S.trip.pages = S.trip.pages && S.trip.pages.map(p => p.type === 'photos' ? { ...p, layout: p.layout === '1full' ? '1full' : pickLayout(p.photoIds, el.dataset.v) } : p); saveTrip(); render(); return; }
  if (el.dataset.layout) { const p = S.trip.pages.find(p => p.id === S.sel); p.layout = el.dataset.layout; saveTrip(); redrawPage(p.id); renderEditor(); return; }
  if (el.dataset.page && !el.dataset.act) {
    document.querySelectorAll('.pg.sel').forEach(x => x.classList.remove('sel'));
    S.sel = el.dataset.page; el.classList.add('sel'); renderEditor();
    if (window.innerWidth < 860) $('#pageEditor').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const act = el.dataset.act, t = S.trip;
  const chEl = el.closest('[data-ch]'), ch = chEl && t && t.chapters.find(c => c.id === chEl.dataset.ch);
  const pi = t && t.pages ? t.pages.findIndex(p => p.id === S.sel) : -1, page = pi >= 0 ? t.pages[pi] : null;
  switch (act) {
    case 'new-trip': { const v = await tripForm({}, true); if (v) { await newTrip(v.title, v); if (v.uploadMode === 'whole') setTimeout(() => toast('Now add your trip photos'), 300); } break; }
    case 'edit-trip': editTripDetails(); break;
    case 'add-day': pendingDay = el.dataset.day; $('#fileIn').click(); break;
    case 'move-day': {
      const id = el.closest('[data-pid]').dataset.pid, ph = S.photos.get(id), keys = tripDays(t), cur = ymd(ph.time);
      const m = modal(`<h2>Move photo to…</h2><div class="day-pick">${keys.map(k => `<button data-k="${k}" ${k === cur ? 'disabled style="opacity:.5"' : ''}><b>Day ${dayNum(t, k)}</b><span>${fmtDay(k)}${(t.days || {})[k] && t.days[k].place ? ' · ' + esc(t.days[k].place) : ''}</span><small>${k === cur ? 'current' : ''}</small></button>`).join('')}</div><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn line" data-a="no">Cancel</button></div>`);
      m.el.addEventListener('click', async e2 => {
        const bt = e2.target.closest('[data-k]');
        if (bt && !bt.disabled) {
          m.close();
          const k = bt.dataset.k, sameDay = [...S.photos.values()].filter(x => ymd(x.time) === k).length;
          ph.day = k; ph.time = ph.exifTime ? dayTime(k, ph.time, 0) : dayTime(k, null, sameDay);
          await DB.put('photos', ph); regroup(); if (t.autoStory !== false) autoCaptions(); saveTrip(true); render(); toast(`Moved to day ${dayNum(t, k)}`);
        } else if (e2.target.dataset.a || e2.target === m.el) m.close();
      });
      break;
    }
    case 'go-daily': {
      const st = tripStats(t), allDated = [...S.photos.values()].every(p => p.exifTime || p.day);
      if (!t.startDate && st.start && allDated) { t.startDate = ymd(st.start); t.endDate = ymd(st.end); }
      if (!t.startDate) {
        const v = await tripForm({ ...t, uploadMode: 'daily' }, false); if (!v) break;
        Object.assign(t, v);
        // undated photos go to day 1; move them with ⇄
        S.photos.forEach(p => { if (!p.exifTime && !p.day) { p.day = t.startDate; p.time = dayTime(t.startDate, null, 0); DB.put('photos', p); } });
        regroup(); if (t.autoStory !== false) autoCaptions(); saveTrip(true); render();
        toast('Undated photos were put on Day 1 — tap ⇄ on a photo to move it');
        break;
      }
      t.uploadMode = 'daily';
      regroup(); saveTrip(true); render(); toast('Day-by-day on — drag or add photos into each day');
      break;
    }
    case 'demo': demoTrip(); break;
    case 'templates': document.querySelector('.tpl-grid').scrollIntoView({ behavior: 'smooth', block: 'center' }); break;
    case 'tpl-gen': genTemplateForm(); break;
    case 'add-photos': if (t && t.uploadMode === 'daily' && tripDays(t).length) pickDayThenUpload(); else { pendingDay = null; $('#fileIn').click(); } break;
    case 'story': storyMode(); break;
    case 'cover': { t.coverId = el.closest('[data-pid]').dataset.pid; t.pages = null; saveTrip(); render(); toast('Cover photo set'); break; }
    case 'del-photo': {
      const id = el.closest('[data-pid]').dataset.pid;
      await DB.del('photos', id); S.photos.delete(id);
      ch.photoIds = ch.photoIds.filter(x => x !== id);
      if (!ch.photoIds.length) t.chapters = t.chapters.filter(c => c !== ch); else recomputeChapter(ch);
      if (t.coverId === id) t.coverId = t.chapters[0]?.photoIds[0] || null;
      t.count = S.photos.size; t.pages = null; saveTrip(); render(); break;
    }
    case 'merge': {
      const i = t.chapters.indexOf(ch), prev = t.chapters[i - 1];
      prev.photoIds.push(...ch.photoIds); recomputeChapter(prev);
      if (ch.caption && !prev.caption) prev.caption = ch.caption;
      t.chapters.splice(i, 1); t.pages = null; saveTrip(); render(); break;
    }
    case 'rebuild': t.pages = buildBook(t); S.sel = null; saveTrip(); render(); toast('Book re-laid out'); break;
    case 'pdf': exportPDF(); break;
    case 'shuffle': if (page) { page.photoIds.push(page.photoIds.shift()); saveTrip(); redrawPage(page.id); } break;
    case 'split': if (page) {
      const half = Math.ceil(page.photoIds.length / 2), rest = page.photoIds.splice(half);
      page.layout = pickLayout(page.photoIds, t.size);
      t.pages.splice(pi + 1, 0, { id: uid(), type: 'photos', chapterId: page.chapterId, photoIds: rest, layout: pickLayout(rest, t.size), caption: '' });
      saveTrip(); render(); break;
    }
    case 'join': if (page) { const nx = t.pages[pi + 1]; page.photoIds.push(...nx.photoIds); page.layout = pickLayout(page.photoIds, t.size); t.pages.splice(pi + 1, 1); saveTrip(); render(); } break;
    case 'move-up': case 'move-down': if (page) {
      const j = act === 'move-up' ? pi - 1 : pi + 1;
      if (j < 1 || j >= t.pages.length - 1) break;
      [t.pages[pi], t.pages[j]] = [t.pages[j], t.pages[pi]]; saveTrip(); render(); break;
    }
    case 'del-page': if (page) { t.pages.splice(pi, 1); S.sel = null; saveTrip(); render(); } break;
    case 'regroup': regroup(); render(); toast('Timeline re-grouped'); break;
    case 'del-trip': {
      const id = el.dataset.id || (t && t.id); const tr = S.trips.find(x => x.id === id) || t;
      if (await confirmBox(`Delete “${(tr && tr.title) || 'this trip'}”?`, 'All its photos, story and photo book will be removed from this device. This can’t be undone.')) {
        await DB.deleteTrip(id); if (S.trip && S.trip.id === id) S.trip = null; await loadTrips(); render(); toast('Trip deleted');
      }
      break;
    }
    case 'rename-trip': {
      const id = el.dataset.id || (t && t.id);
      if (!t || t.id !== id) { await openTrip(id); }
      editTripDetails(); break;
    }
    case 'rename-only': {
      const id = el.dataset.id || (t && t.id);
      const tr = (S.trip && S.trip.id === id) ? S.trip : await DB.get('trips', id);
      const name = await ask('Rename trip', 'Trip name', tr.title || '', 'Save');
      if (name) { tr.title = name; tr.updatedAt = Date.now(); if (S.trip && S.trip.id === id) { saveTrip(true); } else { await DB.put('trips', tr); await loadTrips(); } render(); }
      break;
    }
    case 'play': if (window.Story) Story.open(); break;
    case 'about': showAbout(); break;
  }
});
document.addEventListener('input', e => {
  const el = e.target, t = S.trip; if (!t) return;
  if (el.dataset.toggle) { t[el.dataset.toggle] = el.checked; saveTrip(); return; }
  if (el.dataset.df) {
    const key = el.closest('[data-daykey]').dataset.daykey; t.days = t.days || {};
    const d = t.days[key] = { ...(t.days[key] || {}), [el.dataset.df]: el.value };
    const ch = t.chapters.find(c => c.dayKey === key);
    if (ch) {
      if (el.dataset.df === 'place') {
        ch.title = el.value || `Day ${ch.day}`; ch.place = el.value || ch.place;
        if (!ch.edited && t.autoStory !== false) { const i = t.chapters.indexOf(ch); ch.caption = storyCaption(ch, i, t.chapters.length); const ta = el.closest('.body').querySelector('[data-df=caption]'); if (ta) ta.value = ch.caption; }
      } else { ch.caption = el.value; ch.edited = true; }
    }
    saveTrip(); return;
  }
  if (el.dataset.f) { const ch = t.chapters.find(c => c.id === el.closest('[data-ch]').dataset.ch); ch[el.dataset.f] = el.value; ch.edited = true; saveTrip(); return; }
  if (el.dataset.trip) { t[el.dataset.trip] = el.value; if (el.dataset.trip === 'subtitle') t.subtitleEdited = !!el.value.trim(); $('#crumb').textContent = '/ ' + (t.title || 'Untitled trip'); saveTrip(); const cov = t.pages && t.pages[0]; if (cov) redrawPage(cov.id); return; }
  if (el.dataset.chF) { const page = t.pages.find(p => p.id === S.sel), ch = t.chapters.find(c => c.id === page.chapterId); ch[el.dataset.chF] = el.value; ch.edited = true; saveTrip(); redrawPage(page.id); return; }
  if ('pageCap' in el.dataset) { const page = t.pages.find(p => p.id === S.sel); page.caption = el.value; saveTrip(); redrawPage(page.id); }
});
$('#fileIn').addEventListener('change', e => { const f = e.target.files; if (f && f.length) importFiles(f, pendingDay); pendingDay = null; e.target.value = ''; });
const goHome = async () => { if (S.trip) await saveTrip(true); S.trip = null; S.sel = null; await loadTrips(); render(); window.scrollTo(0, 0); };
$('#homeBtn').addEventListener('click', goHome);
let rT; window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => { if (S.trip && (S.tab === 'map')) drawMapTab(); if (S.trip && S.tab === 'book') mountBook(); }, 250); });
// drag photos anywhere onto an open trip
window.addEventListener('dragover', e => { if (S.trip) e.preventDefault(); });
window.addEventListener('drop', e => { if (S.trip && !e.target.closest('#drop')) { e.preventDefault(); importFiles(e.dataTransfer.files); } });
// Android hardware back button
try {
  const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (App) App.addListener('backButton', () => { if (window.Story && Story.isOpen()) Story.close(); else if (document.querySelector('.modal-bg')) document.querySelector('.modal-bg').remove(); else if (S.trip) goHome(); else App.exitApp(); });
} catch (e) { }

(async function init() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
  try { await loadTrips(); } catch (e) { $('#main').innerHTML = `<div class="empty-note">Storage is unavailable in this browser view (${esc(e.message)}). Install the app or open it in a normal browser window.</div>`; return; }
  render();
})();
