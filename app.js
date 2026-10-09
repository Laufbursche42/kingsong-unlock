'use strict';
/*
 * KINGSONG Tuning - Web Bluetooth. Implements the BLE protocol of com.kingsong.dlc (EUC app).
 * Transport (code-proven): primary GATT FFE0 with a single char FFE1 (write-no-response + notify, CCCD
 * 0x2902); alternate GATT AD00 with AD01 write + AD02 notify. Outbound control frames are a fixed 20 bytes
 * (AA 55 header, opcode at byte[16], sub-length at byte[17], 0x5A 0x5A footer, payload in bytes[2..15]).
 * Outbound builders: 0x87 (max-speed / weak-magnetic, byte[4]=value), 0x8A/0x8B (max speed + km/h<->mph
 * unit, byte[2]=11/9, byte[4..5]=LE), 0x7E (electronic lock/stop-switch, byte[2]=state), 0x6C (headlight,
 * byte[2]=on/off), 0x1B (ride/pedal mode, byte[2]=mode), 0x5E (status readback request).
 * Inbound telemetry (recovered from MainFragmentAty.a2): frames carry an F1 EF header with the opcode at
 * byte[16]. 0xC2 = voltage fx.A(b2,b3)/100, speed fx.A(b4,b5)/100, total distance fx.D(b8,b9,b6,b7)/1000,
 * ride time fx.B(b10,b11)/60. 0xC5 = trip distance fx.D(b4,b5,b2,b3)/1000. 0xC9 = ride mode b2, lock b3,
 * unit b6 (1=mph), cruise b12. fx.A = LE signed16, fx.B = LE unsigned16, fx.D = LE 32-bit.
 * Writes are gated behind a connection and the risky ones are confirm-boxed. An echo only means "accepted";
 * only live behaviour on the wheel proves a write took effect. KingSong builds electric unicycles (EUC).
 */

// Pre-commit cache-buster auto-bumps BUILD and every ?v= on any web-asset change.
const BUILD = 'v4';

// --------------------------- UUIDs (BleService.java:64-84; Web Bluetooth wants lowercase) ---------------------------
const U = {
  FFE0: '0000ffe0-0000-1000-8000-00805f9b34fb',   // primary data service
  FFE1: '0000ffe1-0000-1000-8000-00805f9b34fb',   // primary char: WRITE_NO_RESPONSE + NOTIFY (CCCD 0x2902)
  AD00: '0000ad00-0000-1000-8000-00805f9b34fb',   // alternate data service (queued write-drainer path)
  AD01: '0000ad01-0000-1000-8000-00805f9b34fb',   // alternate write char
  AD02: '0000ad02-0000-1000-8000-00805f9b34fb'    // alternate notify char
};
// Two known transports; the connect probe tries them in order (device_side which one a given wheel uses).
const TRANSPORTS = [
  { svc: U.FFE0, write: U.FFE1, notify: U.FFE1 },
  { svc: U.AD00, write: U.AD01, notify: U.AD02 }
];
const CANDIDATE_SERVICES = TRANSPORTS.map(t => t.svc);
let activeWrite = U.FFE1;   // the write char uuid actually resolved (for the log label)

// Models with a hardcoded name branch in the app (shared protocol; the choice is a label only).
const MODELS = ['KS-S22', 'KS-S20', 'KS-X1', 'KS-N8', 'KS-N10', 'KS-N1-B', 'KS-18L', 'KS-F22'];

// --------------------------- helpers ---------------------------
const $ = (id) => document.getElementById(id);
const hex = (arr) => Array.from(arr, b => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(' ');
const short = (u) => String(u).slice(0, 8).toUpperCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LS = { THEME: 'kingsong_theme', OPEN: 'kingsong_open', PUBLOG: 'kingsong_publog', DEV: 'kingsong_device' };

let dev = null, server = null, chW = null, chN = null, busy = false;
let connected = false;

// --------------------------- log (eg-unlock redaction pipeline: scrub secrets + anonymize PII) ---------------------------
let logBuffer = [];   // { raw, cls }
let publicLog = true; // anonymize device name/id/MAC on display/copy/save (default on)
let diag = false;     // verbose diagnostics (default off)
function redact(text) {
  let s = String(text);
  if (dev && dev.id) s = s.split(dev.id).join('[redacted-id]');
  s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[redacted-mac]');
  s = s.replace(/\b(secret|token|key|aes|pwd|password|pin|mac|serial|vin|uid|imei)\b(\s*[:=]\s*)("?)([^\s",]+)\3/gi,
    (m, k, sep) => k + sep + '[redacted]');
  s = s.replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]');
  return s;
}
// Unconditional secret scrubber, runs at the source before the buffer (independent of the Public Log toggle).
function maskSecrets(text) {
  let s = String(text);
  s = s.replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  s = s.replace(/\b(access[_-]?token|refresh[_-]?token|token|jwt|password|passwd|pwd|secret|code|otp)\b(\s*[:=]\s*)("?)([^\s",}]+)\3/gi,
    (m, k, sep) => k + sep + '***');
  return s;
}
function anonymize(s) {
  if (!publicLog) return String(s).replace(/\x01/g, '');
  return redact(String(s).replace(/\x01[^\x01]*\x01/g, 'XX').replace(/\x01/g, ''));
}
function logLine(cls, text) {
  const safe = '[' + new Date().toTimeString().slice(0, 8) + '] ' + maskSecrets(text);
  logBuffer.push({ raw: safe, cls: cls });
  const el = $('log'); if (!el) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = anonymize(safe) + '\n';
  el.appendChild(span); el.scrollTop = el.scrollHeight;
}
function renderLog() {
  const el = $('log'); if (!el) return;
  el.textContent = '';
  for (const e of logBuffer) { const span = document.createElement('span'); if (e.cls) span.className = e.cls; span.textContent = anonymize(e.raw) + '\n'; el.appendChild(span); }
  el.scrollTop = el.scrollHeight;
}
function logText() { return logBuffer.map(e => anonymize(e.raw)).join('\n'); }
const logTx = (b) => logLine('log-tx', '>>> ' + short(activeWrite) + ' | ' + hex(b));
const logRx = (b) => logLine('log-rx', '<<< ' + short(activeWrite) + ' | ' + hex(b));
const logSys = (t) => logLine('', '--- ' + t);
const logErr = (t) => logLine('log-err', '!!! ' + t);
const logDiag = (t) => { if (diag) logLine('', '... ' + t); };
// CRLF on Windows so the copied log pastes cleanly into Notepad (nv osNewline polish).
function osNewline() { return (navigator.platform || '').toLowerCase().indexOf('win') === 0 ? '\r\n' : '\n'; }
function saveLog() {
  try {
    const blob = new Blob([logText().split('\n').join(osNewline())], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'laufbursche42-kingsong-log.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logSys('log saved');
  } catch (e) { logErr('save failed: ' + (e && e.message ? e.message : e)); }
}
function logDiagnosticHeader() {
  logLine('', '=== kingsong-unlock diagnostic ===');
  logLine('', 'build: ' + BUILD);
  logLine('', 'time: ' + new Date().toISOString());
  logLine('', 'userAgent: ' + (navigator.userAgent || '?'));
  logLine('', 'platform: ' + (navigator.platform || '?'));
  logLine('', 'webBluetooth: ' + (navigator.bluetooth ? 'yes' : 'no'));
  logLine('', 'protocol self-test: ' + (FRAME_OK ? 'OK' : 'FAILED'));
  logLine('', '================================');
}

// =========================================================================================
//  VERIFIED PROTOCOL CORE (code-proven from com.kingsong.dlc; self-test below runs at load)
// =========================================================================================
// Outbound frame: fixed 20 bytes. [0]=0xAA [1]=0x55 header; payload in [2..15]; [16]=opcode; [17]=sub-length
// flag (usually 0x14=20); [18]=[19]=0x5A footer (fx.java:1622-1631). FRAME_OK asserts the skeleton + the
// per-opcode payload byte positions.
const FRAME_LEN = 20;
function frameBase(op, sublen) {
  const f = new Array(FRAME_LEN).fill(0);
  f[0] = 0xAA; f[1] = 0x55;
  f[16] = op & 0xff;
  f[17] = (sublen == null ? 0x14 : sublen) & 0xff;
  f[18] = 0x5A; f[19] = 0x5A;
  return f;
}
// expert free builder: payload laid sequentially into [2..15] (max 14 bytes)
function buildFramePayload(op, payload, sublen) {
  const f = frameBase(op, sublen);
  payload = (payload || []).map(b => b & 0xff);
  for (let i = 0; i < payload.length && i < 14; i++) f[2 + i] = payload[i];
  return f;
}
// lenient validator: known header (outbound AA55 or inbound F1EF) + exact length.
function validFrame(f) {
  if (!(Array.isArray(f) && f.length === FRAME_LEN)) return false;
  const h0 = f[0] & 0xff, h1 = f[1] & 0xff;
  return (h0 === 0xAA && h1 === 0x55) || (h0 === 0xF1 && h1 === 0xEF);
}
function footerOk(f) { return (f[18] & 0xff) === 0x5A && (f[19] & 0xff) === 0x5A; }
function isInbound(f) { return (f[0] & 0xff) === 0xF1 && (f[1] & 0xff) === 0xEF; }

// --- outbound command builders (only opcodes proven from the app; payload bytes beyond the documented ones stay 0) ---
// 0x87: set max-speed limit / weak-magnetic (field-weakening) overclock speed; byte[4]=value (SpeedSettingActivity.java:366-368).
function cmdMaxSpeed(kmh) { const f = frameBase(0x87); f[4] = kmh & 0xff; return f; }
// 0x8B (km/h, selector [2]=9) / 0x8A (mph, selector [2]=11): set max speed + unit; value LE at [4..5] (fx.b2).
function cmdUnit(mph, kmh) { const f = frameBase(mph ? 0x8A : 0x8B); f[2] = mph ? 11 : 9; f[4] = kmh & 0xff; f[5] = (kmh >> 8) & 0xff; return f; }
// 0x7E: electronic lock / stop-switch toggle; byte[2]=state (StopSwitchActivity.java:93).
function cmdLock(on) { const f = frameBase(0x7E); f[2] = on ? 1 : 0; return f; }
// 0x6C: headlight on/off; byte[2]=on/off (LightSettingActivity.java:104).
function cmdLight(on) { const f = frameBase(0x6C); f[2] = on ? 1 : 0; return f; }
// 0x1B: ride/pedal mode; byte[2]=mode (RideModeActivityNew.java). Mode->byte mapping is device_side.
function cmdMode(mode) { const f = frameBase(0x1B); f[2] = mode & 0xff; return f; }
// 0x5E: request current settings/status readback (sent after unlock, PasswordActivity.java:218).
function cmdStatusReq() { return frameBase(0x5E); }

// --- inbound telemetry decoders (fx.A/B/D, recovered from MainFragmentAty.a2) ---
const sA = (b2, b3) => { const v = ((b2 & 0xff) | ((b3 & 0xff) << 8)); return v >= 0x8000 ? v - 0x10000 : v; };   // fx.A LE signed16
const uB = (b2, b3) => (b2 & 0xff) + ((b3 & 0xff) * 256);                                                         // fx.B LE unsigned16
const lD = (b2, b3, b4, b5) => (b2 & 0xff) + ((b3 & 0xff) * 256) + ((b4 & 0xff) * 65536) + ((b5 & 0xff) * 16777216); // fx.D LE32

const OPCODE_LABEL = {
  // inbound telemetry (F1 EF)
  0xC2: 'telemetry (speed/volt/total)', 0xC5: 'telemetry (trip)', 0xC9: 'settings feedback',
  // outbound control (AA 55)
  0x40: 'status/info', 0x44: 'car-password', 0x45: 'status/info', 0x46: 'password result',
  0x47: 'handshake', 0x4A: 'status/info', 0x53: 'light', 0x56: 'voice', 0x57: 'voice',
  0x5B: 'light mode', 0x5D: 'config apply', 0x5E: 'status readback', 0x6C: 'headlight',
  0x73: 'voice', 0x7E: 'lock/stop-switch', 0x85: 'speed alarms', 0x87: 'max-speed/weak-mag',
  0x8A: 'max speed (mph)', 0x8B: 'max speed (km/h)', 0x95: 'voice/rgb', 0x98: 'query settings',
  0x99: 'query settings', 0x1B: 'ride mode'
};

// load-time self-test: builders must match hand-computed byte vectors; every built frame must re-validate
const FRAME_OK = (function () {
  const eq = (a, b) => a.length === b.length && a.every((v, i) => (v & 0xff) === (b[i] & 0xff));
  const v1 = cmdLight(true);   // byte[2]=1 opcode 0x6C -> AA 55 01 00 ..0.. 6C 14 5A 5A
  const t1 = eq(v1, [0xAA, 0x55, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x6C, 0x14, 0x5A, 0x5A]);
  const v2 = cmdMaxSpeed(50);  // byte[4]=0x32
  const t2 = eq(v2, [0xAA, 0x55, 0x00, 0x00, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x87, 0x14, 0x5A, 0x5A]);
  const v3 = cmdLock(true);    // byte[2]=1 opcode 0x7E
  const t3 = eq(v3, [0xAA, 0x55, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x7E, 0x14, 0x5A, 0x5A]);
  // decoder self-test: speed 25.00 km/h (2500 LE), voltage 84.00 V (8400 LE)
  const t4 = sA(0xC4, 0x09) === 2500 && sA(0xD0, 0x20) === 8400 && uB(0x3C, 0x00) === 60 && lD(0x10, 0x27, 0, 0) === 10000;
  return t1 && t2 && t3 && t4 && validFrame(v1) && validFrame(v2) && validFrame(v3)
    && footerOk(v1) && footerOk(v2) && footerOk(v3);
})();

// --------------------------- tiles (decoded live telemetry from a2) ---------------------------
const TILE_IDS = ['t-speed', 't-volt', 't-total', 't-trip', 't-time', 't-mode', 't-unit', 't-lock', 't-cruise'];
const state = {};   // decoded field -> display value
const MODE_NAMES = ['modeSoft', 'modeMed', 'modeHard'];
function setTile(id, val) { const el = $(id); if (el) el.textContent = (val == null ? '-' : val); }
function resetTiles() { for (const k of Object.keys(state)) delete state[k]; TILE_IDS.forEach(id => setTile(id, null)); }
function refreshTiles() {
  setTile('t-speed', state.speed == null ? null : state.speed.toFixed(1));
  setTile('t-volt', state.volt == null ? null : state.volt.toFixed(2));
  setTile('t-total', state.total == null ? null : state.total.toFixed(1));
  setTile('t-trip', state.trip == null ? null : state.trip.toFixed(1));
  setTile('t-time', state.time == null ? null : String(state.time));
  setTile('t-mode', state.mode == null ? null : (t(MODE_NAMES[state.mode]) || String(state.mode)));
  setTile('t-unit', state.unit == null ? null : state.unit);
  setTile('t-lock', state.lock == null ? null : t(state.lock ? 'valOn' : 'valOff'));
  setTile('t-cruise', state.cruise == null ? null : t(state.cruise ? 'valOn' : 'valOff'));
}
// decode an inbound F1 EF frame into state (opcode at byte[16]); offsets recovered from MainFragmentAty.a2
function decodeTelemetry(f) {
  const op = f[16] & 0xff;
  if (op === 0xC2) {
    state.volt = sA(f[2], f[3]) / 100;
    state.speed = sA(f[4], f[5]) / 100;
    state.total = lD(f[8], f[9], f[6], f[7]) / 1000;
    state.time = Math.floor(uB(f[10], f[11]) / 60);
  } else if (op === 0xC5) {
    state.trip = lD(f[4], f[5], f[2], f[3]) / 1000;
  } else if (op === 0xC9) {
    let m = f[2] & 0xff; if (m === 4) m = 0;
    state.mode = m;
    state.lock = (f[3] & 0xff) ? 1 : 0;
    state.unit = (f[6] & 0xff) === 1 ? 'mph' : 'km/h';
    state.cruise = (f[12] & 0xff) ? 1 : 0;
  }
}

// --------------------------- last-frame-by-opcode store (used by the frame handler) ---------------------------
const seenFrames = {};   // opcode -> last frame bytes
function resetState() { for (const k of Object.keys(seenFrames)) delete seenFrames[k]; }

// --------------------------- i18n ---------------------------
let lang = 'de';
function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => { const v = t(n.getAttribute('data-t')); if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v; }); // scan-ok: curated i18n values with markup (banner/disclaimer links); own table, not user input
  document.querySelectorAll('[data-t-ph]').forEach(n => { const v = t(n.getAttribute('data-t-ph')); if (v) n.setAttribute('placeholder', v); });
  ['GUIDE', 'README', 'LICENSE', 'PRIVACY', 'TRADEMARKS'].forEach(name => { const el = $('link-' + name.toLowerCase()); if (el) el.href = docFile(name); });
  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  document.querySelectorAll('#langs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  { const sel = $('model-in'); if (sel) { const opt = sel.options[0]; if (opt && !opt.value) opt.textContent = t('modelAuto'); } }
  refreshTiles();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  { const dark = document.documentElement.getAttribute('data-theme') !== 'light'; const el = $('btn-theme'); if (el) { el.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); el.title = el.getAttribute('aria-label'); } }
}
function initLangSwitch() { document.querySelectorAll('#langs button').forEach(b => b.addEventListener('click', () => { lang = b.dataset.lang; applyLang(); })); }
function initModels() {
  const sel = $('model-in'); if (!sel) return;
  const auto = document.createElement('option'); auto.value = ''; auto.textContent = t('modelAuto'); sel.appendChild(auto);
  MODELS.forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
}

// --------------------------- theme ---------------------------
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) { b.textContent = dark ? '\u2600' : '\u263E'; b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); b.title = b.getAttribute('aria-label'); }
  try { localStorage.setItem(LS.THEME, dark ? 'dark' : 'light'); } catch (e) {}
}
function initTheme() {
  let saved = null; try { saved = localStorage.getItem(LS.THEME); } catch (e) {}
  applyTheme(saved !== 'light');
  const b = $('btn-theme'); if (b) b.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light'));
}

// --------------------------- status ---------------------------
function statusLabel(s) {
  const map = { disconnected: 'stDisconnected', connecting: 'stConnecting', linking: 'stLinking', connected: 'stConnected', 'no-service': 'stNoService' };
  return t(map[s] || 'stDisconnected') || s;
}
function setStatus(s) {
  const el = $('status'); if (el) { el.dataset.state = s; el.textContent = statusLabel(s); }
  const cb = $('btn-conn');
  if (cb) { const on = (s === 'connecting' || s === 'linking' || s === 'connected'); cb.textContent = on ? t('btnDisconnect') : t('btnConnect'); cb.dataset.act = on ? 'disconnect' : 'connect'; }
}
function setControlsEnabled(on) {
  // cards hidden until connected (header/intro/connect/log stay visible)
  ['live-card', 'batt-card', 'more-card', 'raw-card'].forEach(id => { const el = $(id); if (el) el.hidden = !on; });
  document.querySelectorAll('[data-conn]').forEach(e => { e.disabled = !on; });
}

// --------------------------- connect (acceptAll + GATT service is the real gate; 4x retry) ---------------------------
async function connect() {
  if (!navigator.bluetooth) { logErr(t('errNoWebBt')); return; }
  try {
    setStatus('connecting');
    const showAll = ($('showall') || {}).checked;
    const opts = showAll
      ? { acceptAllDevices: true, optionalServices: CANDIDATE_SERVICES }
      : { filters: [{ services: [U.FFE0] }, { services: [U.AD00] }], optionalServices: CANDIDATE_SERVICES };
    dev = await navigator.bluetooth.requestDevice(opts);
    dev.addEventListener('gattserverdisconnected', onDisconnected);
    try { localStorage.setItem(LS.DEV, dev.id); } catch (e) {}
    logSys('device: \x01' + (dev.name || '(no name)') + '\x01');
    setStatus('linking');
    await connectGatt();
    setStatus('connected'); connected = true;
    setControlsEnabled(true);
    { const el = $('devinfo'); if (el) el.textContent = t('devPrefix') + ' \x01' + (dev.name || 'KINGSONG') + '\x01'; }
    logSys('connected, subscribed to ' + short(chN && chN.uuid || activeWrite));
  } catch (e) {
    logErr('connect failed: ' + (e && e.message ? e.message : e));
    connected = false; setStatus('disconnected'); setControlsEnabled(false);
  }
}
// tolerate the Android discovery race (nv 4x retry): service can be briefly absent right after link.
async function connectGatt() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      server = await dev.gatt.connect();
      const tr = await resolveTransport(server);
      if (!tr) { setStatus('no-service'); throw new Error('KINGSONG service (FFE0 or AD00) not found'); }
      activeWrite = tr.write;
      chN = await tr.svcObj.getCharacteristic(tr.notify);
      chW = (tr.write === tr.notify) ? chN : await tr.svcObj.getCharacteristic(tr.write);
      await chN.startNotifications();
      chN.addEventListener('characteristicvaluechanged', onCharValue);
      logDiag('transport: svc ' + short(tr.svc) + ' write ' + short(tr.write) + ' notify ' + short(tr.notify));
      return;
    } catch (e) {
      lastErr = e; logDiag('connect attempt ' + attempt + ' failed: ' + (e && e.message ? e.message : e));
      try { if (dev.gatt.connected) dev.gatt.disconnect(); } catch (_) {}
      await sleep(400);
    }
  }
  throw lastErr || new Error('gatt connect failed');
}
async function resolveTransport(srv) {
  for (const tr of TRANSPORTS) {
    try { const svcObj = await srv.getPrimaryService(tr.svc); if (svcObj) return Object.assign({ svcObj }, tr); } catch (_) {}
  }
  return null;
}
function onDisconnected() {
  connected = false; chW = null; chN = null; setStatus('disconnected'); setControlsEnabled(false);
  resetState(); resetTiles(); clearAcks();
  const el = $('devinfo'); if (el) el.textContent = '';
  logSys('disconnected');
}
function disconnect() { if (dev && dev.gatt.connected) dev.gatt.disconnect(); }

// --------------------------- notify + ACK ---------------------------
let rxBuf = [];
function onCharValue(ev) {
  const b = Array.from(new Uint8Array(ev.target.value.buffer));
  logRx(b);
  for (const x of b) rxBuf.push(x);
  // frames are a fixed 20 bytes; sync on a known header (inbound F1 EF or an echoed outbound AA 55)
  while (rxBuf.length >= FRAME_LEN) {
    const h0 = rxBuf[0] & 0xff, h1 = rxBuf[1] & 0xff;
    if (!((h0 === 0xF1 && h1 === 0xEF) || (h0 === 0xAA && h1 === 0x55))) { rxBuf.shift(); continue; }
    const frame = rxBuf.slice(0, FRAME_LEN); rxBuf = rxBuf.slice(FRAME_LEN);
    handleFrame(frame);
  }
}
function handleFrame(frame) {
  const op = frame[16] & 0xff;   // opcode lives at byte[16], not byte[2]
  seenFrames[op] = frame;
  if (isInbound(frame)) decodeTelemetry(frame);
  resolveAck('op:' + op);
  refreshTiles();
}
const pendingAcks = new Map();
const ACK_TIMEOUT_MS = 3000;
function armAck(key, label) {
  clearAckTimer(key);
  const timer = setTimeout(() => { pendingAcks.delete(key); logSys(label + ': ' + t('ackNone')); }, ACK_TIMEOUT_MS);
  pendingAcks.set(key, { timer, label });
}
function resolveAck(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); logSys(a.label + ': ' + t('ackOk')); } }
function clearAckTimer(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); } }
function clearAcks() { for (const a of pendingAcks.values()) clearTimeout(a.timer); pendingAcks.clear(); }

// --------------------------- transmit (single funnel: log TX, arm ack, write) ---------------------------
async function writeFrame(bytes) {
  const arr = Uint8Array.from(bytes.map(b => b & 0xff));
  // KingSong writes WITHOUT response (BleService.java:988-991, setWriteType(1)); fall back if the stack differs.
  if (chW.properties.writeWithoutResponse) return chW.writeValueWithoutResponse(arr);
  if (chW.properties.write) return chW.writeValueWithResponse(arr);
  return chW.writeValue(arr);
}
async function transmit(bytes, label, ackKey) {
  if (!connected || !chW) { logErr(t('errNotConnected')); return; }
  logTx(bytes);
  if (ackKey) armAck(ackKey, label);
  try { await writeFrame(bytes); logSys(label + ': ' + t('txSent')); }
  catch (e) { clearAckTimer(ackKey); logErr(label + ' ' + t('txFailed') + ': ' + (e && e.message ? e.message : e)); }
}
// serialize writes on the single characteristic (eg guard mutex; vr/ap/vmax omit it)
async function guard(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { logErr(e && e.message ? e.message : String(e)); } finally { busy = false; } }

// --------------------------- commands ---------------------------
async function setMaxSpeed(kmh) { await transmit(cmdMaxSpeed(kmh), t('speedLabel') + ' ' + (kmh & 0xff) + ' km/h', 'op:0x87'); }
async function setUnit(mph, kmh) { await transmit(cmdUnit(mph, kmh), t('setUnit') + ' ' + (mph ? 'mph' : 'km/h'), mph ? 'op:0x8a' : 'op:0x8b'); }
async function setLight(on) { await transmit(cmdLight(on), t('setLight'), 'op:0x6c'); }
async function setMode(mode) { await transmit(cmdMode(mode), t('setMode'), 'op:0x1b'); }
async function doLock(on) { if (!await confirmRisky(t(on ? 'warnLock' : 'warnUnlock'))) return; await transmit(cmdLock(on), t(on ? 'btnImmobLock' : 'btnImmobUnlock'), 'op:0x7e'); }
async function reqStatus() { await transmit(cmdStatusReq(), t('setStatus'), 'op:0x5e'); }

// --------------------------- engine level (raw verbatim + free builder) ---------------------------
function hexToBytes(s) {
  const clean = String(s).replace(/[^0-9a-fA-F]/g, '');   // strip spaces/punctuation
  const out = []; for (let i = 0; i + 2 <= clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));   // pairs; drop a dangling nibble
  return out;
}
async function cmdRaw() {
  const bytes = hexToBytes(($('raw-in') || {}).value || '');
  if (!bytes.length) { logErr(t('errNoBytes')); return; }
  await transmit(bytes, t('rawLabel'));   // sent verbatim, no header/footer added
}
async function cmdFree() {
  const op = parseInt(($('free-op') || {}).value, 16);
  if (isNaN(op)) { logErr(t('errBadOp')); return; }
  const payload = hexToBytes(($('free-payload') || {}).value || '');
  await transmit(buildFramePayload(op, payload), t('freeLabel') + ' 0x' + (op & 0xff).toString(16));   // proper AA55..5A5A frame
}

// --------------------------- confirm dialog (themed; window.confirm fallback) ---------------------------
function confirmRisky(msg) {
  return new Promise(resolve => {
    const dlg = $('confirm'); const body = $('confirm-body');
    if (!dlg || !dlg.showModal) { resolve(window.confirm(msg)); return; }
    if (body) body.textContent = msg;
    const ok = $('confirm-ok'), cancel = $('confirm-x'), no = $('confirm-no');
    const done = (v) => { dlg.close(); ok.removeEventListener('click', onOk); if (no) no.removeEventListener('click', onNo); if (cancel) cancel.removeEventListener('click', onNo); resolve(v); };
    const onOk = () => done(true), onNo = () => done(false);
    ok.addEventListener('click', onOk); if (no) no.addEventListener('click', onNo); if (cancel) cancel.addEventListener('click', onNo);
    dlg.showModal();
  });
}

// --------------------------- doc viewer (markdown of our own docs) ---------------------------
const DOC_TITLES = { 'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide', 'README.md': 'footReadme', 'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense', 'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy', 'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks' };
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = s => s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
function docFile(name) { if (name === 'README') return 'README.md'; if (name === 'GUIDE') return 'GUIDE.' + lang + '.md'; return name + (lang === 'de' ? '.de.md' : '.md'); }
function mdToHtml(src) {
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => DOC_TITLES[href] ? '<a href="' + href + '" data-docfile="' + href + '">' + text + '</a>' : '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>');
  const lines = String(src).split(/\r?\n/); let html = '', inList = false, inCode = false;
  for (const ln of lines) {
    if (/^```/.test(ln)) { if (inCode) { html += '</pre>'; inCode = false; } else { if (inList) { html += '</ul>'; inList = false; } html += '<pre class="doc-code">'; inCode = true; } continue; }
    if (inCode) { html += escHtml(ln) + '\n'; continue; }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) { if (inList) { html += '</ul>'; inList = false; } const lvl = h[1].length + 1; html += '<h' + lvl + ' id="' + slug(h[2]) + '">' + inline(h[2]) + '</h' + lvl + '>'; continue; }
    const li = ln.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(li[1]) + '</li>'; continue; }
    if (/^\s*$/.test(ln)) { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += '<p>' + inline(ln) + '</p>';
  }
  if (inList) html += '</ul>'; if (inCode) html += '</pre>';
  return html;
}
const docCache = {};
async function openDocFile(file) {
  const dlg = $('doc'); const titleEl = $('doc-title'); const bodyEl = $('doc-body');
  titleEl.textContent = t(DOC_TITLES[file] || 'footReadme');
  if (lang === 'de' && /\.md$/.test(file) && !/\.de\.md$/.test(file) && file !== 'README.md') titleEl.textContent += ' (englisch)';
  try { if (!docCache[file]) { const r = await fetch(file); docCache[file] = await r.text(); } bodyEl.innerHTML = mdToHtml(docCache[file]); } // scan-ok: own in-repo markdown rendered via mdToHtml; not user input
  catch (e) { bodyEl.textContent = 'Could not load ' + file; }
  if (dlg.showModal) dlg.showModal();
}
function wireDocViewer() {
  // delegated: footer doc links, the intro guide link (injected by i18n at runtime), in-doc links, disclaimer
  document.addEventListener('click', e => {
    const d = e.target.closest('a[data-doc]'); if (d) { e.preventDefault(); openDocFile(docFile(d.getAttribute('data-doc'))); return; }
    const df = e.target.closest('a[data-docfile]'); if (df) { e.preventDefault(); openDocFile(df.getAttribute('data-docfile')); return; }
    const disc = e.target.closest('[data-open-disclaimer]'); if (disc) { e.preventDefault(); openHelpText(t('footDisclaimer'), t('disclaimerText')); return; }
  });
  ['doc-x', 'doc-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', () => $('doc').close()); });
}

// --------------------------- help modal ---------------------------
function openHelp(key) { openHelpText(t('help_' + key + '_t'), t('help_' + key + '_b')); }
function openHelpText(title, body) {
  const dlg = $('help'); $('help-title').textContent = title || ''; const b = $('help-body'); if (/[<&]/.test(body || '')) b.innerHTML = body; else b.textContent = body || ''; // scan-ok: curated i18n help text; own table, not user input
  if (dlg.showModal) dlg.showModal();
}
function closeHelp() { const d = $('help'); if (d) d.close(); }

// --------------------------- init ---------------------------
window.addEventListener('DOMContentLoaded', () => {
  initLangSwitch(); initTheme(); initModels(); wireDocViewer();
  try { const o = localStorage.getItem(LS.OPEN); if (o && $('maxspeed-in')) $('maxspeed-in').value = o; } catch (e) {}
  applyLang(); setStatus('disconnected'); resetTiles();
  logDiagnosticHeader();
  if (!FRAME_OK) logErr('protocol self-test FAILED - builders do not match known vectors; do not trust writes');

  $('btn-conn').addEventListener('click', () => { if ($('btn-conn').dataset.act === 'disconnect') disconnect(); else guard(connect); });
  { const o = $('maxspeed-in'); if (o) o.addEventListener('change', () => { try { localStorage.setItem(LS.OPEN, o.value); } catch (e) {} }); }

  // speed card
  { const b = $('btn-setspeed'); if (b) b.addEventListener('click', () => guard(async () => { const v = parseInt(($('maxspeed-in') || {}).value, 10); if (!(v >= 1 && v <= 99)) { logErr(t('errSpeedRange')); return; } if (!await confirmRisky(t('warnSpeed'))) return; await setMaxSpeed(v); })); }
  { const b = $('btn-unit-kmh'); if (b) b.addEventListener('click', () => guard(async () => { const v = parseInt(($('maxspeed-in') || {}).value, 10) || 25; await setUnit(false, v); })); }
  { const b = $('btn-unit-mph'); if (b) b.addEventListener('click', () => guard(async () => { const v = parseInt(($('maxspeed-in') || {}).value, 10) || 25; await setUnit(true, v); })); }

  // more settings
  { const b = $('btn-mode'); if (b) b.addEventListener('click', () => guard(async () => { if (!await confirmRisky(t('warnMode'))) return; await setMode(parseInt(($('mode-in') || {}).value, 10) || 0); })); }
  { const b = $('btn-light'); if (b) b.addEventListener('click', () => guard(() => setLight((($('light-in') || {}).value) === '1'))); }
  { const b = $('btn-immob-lock'); if (b) b.addEventListener('click', () => guard(() => doLock(true))); }
  { const b = $('btn-immob-unlock'); if (b) b.addEventListener('click', () => guard(() => doLock(false))); }

  // engine level
  { const b = $('btn-status'); if (b) b.addEventListener('click', () => guard(reqStatus)); }
  { const b = $('btn-raw'); if (b) b.addEventListener('click', () => guard(cmdRaw)); }
  { const b = $('btn-free'); if (b) b.addEventListener('click', () => guard(cmdFree)); }

  document.querySelectorAll('.help-btn[data-help]').forEach(btn => btn.addEventListener('click', () => openHelp(btn.getAttribute('data-help'))));
  ['help-x', 'help-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', closeHelp); });
  { const b = $('link-disclaimer'); if (b) b.addEventListener('click', e => { e.preventDefault(); openHelpText(t('footDisclaimer'), t('disclaimerText')); }); }

  { const cb = $('public-log'); if (cb) { let saved = null; try { saved = localStorage.getItem(LS.PUBLOG); } catch (e) {} publicLog = saved !== '0'; cb.checked = publicLog; cb.addEventListener('change', () => { publicLog = cb.checked; try { localStorage.setItem(LS.PUBLOG, cb.checked ? '1' : '0'); } catch (e) {} renderLog(); }); } }
  { const cb = $('diag-log'); if (cb) { cb.addEventListener('change', () => { diag = cb.checked; logSys(diag ? 'diagnostic log on' : 'diagnostic log off'); }); } }
  { const b = $('btn-clear-log'); if (b) b.addEventListener('click', () => { logBuffer = []; $('log').textContent = ''; logDiagnosticHeader(); }); }
  { const b = $('btn-copy-log'); if (b) b.addEventListener('click', () => navigator.clipboard.writeText(logText()).then(() => logSys('log copied')).catch(() => {})); }
  { const b = $('btn-save-log'); if (b) b.addEventListener('click', saveLog); }
});
