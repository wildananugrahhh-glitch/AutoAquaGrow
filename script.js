'use strict';
/* AutoAquaGrow front end (plain HTML, CSS, JavaScript; works on GitHub Pages).
   DATA INTEGRITY: until Firebase delivers a snapshot, every value is simulated DEMO data and the page says so.
   FIREBASE STRUCTURE the ESP32 writes (Realtime Database):
     devices/esp32-01/latest  = { adc:0-4095, pump:bool, relay:bool, wifiRssi:int, sensorOk:bool,
                                  pumpCount:int, pumpSeconds:int, updatedAt:epoch-ms }
     devices/esp32-01/config  = { on:% start below, off:% stop above, to:seconds }   (written by this site)
     devices/esp32-01/command = { pumpTestSec:int, at:epoch-ms }                    (optional, written by this site)
   CREDENTIALS: copy firebase-config.example.js to firebase-config.js and paste the PUBLIC web config only.
   Never commit service-account keys, passwords or admin secrets. Restrict access with Realtime Database rules. */
const CFG = { deviceId: 'esp32-01', staleMs: 120000, adcLow: 50, adcHigh: 4045, sdk: 'https://www.gstatic.com/firebasejs/10.12.2/' };
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const store = { get(k, d) { try { const v = localStorage.getItem('aag.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('aag.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } } };
const S = { live: null, fb: null, scen: 'moderate', range: 'daily', cal: store.get('cal', { dry: null, wet: null, flow: null }), cfg: store.get('cfg', { on: 35, off: 60, to: 60 }), log: [], testing: false };
const DEMO = { dry: { adc: 3020, pump: true, esp: true }, moderate: { adc: 2380, pump: false, esp: true }, moist: { adc: 1600, pump: false, esp: true }, offline: { adc: 2380, pump: false, esp: false } };
const DEMO_LABEL = { dry: 'Dry', moderate: 'Moderate', moist: 'Moist', offline: 'Moderate' };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmtDur = (s) => (s == null ? 'Not reported' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s');

/* ---------- data layer ---------- */
function cur() {
  const l = S.live;
  if (l) {
    const age = l.updatedAt ? Date.now() - l.updatedAt : Infinity, ok = age <= CFG.staleMs;
    return { demo: false, adc: l.adc, pump: l.pump && ok, relay: l.relay && ok, esp: ok, wifi: ok && l.rssi != null, sensor: l.sensor, ts: l.updatedAt, cnt: l.count, secs: l.secs };
  }
  const d = DEMO[S.scen];
  return { demo: true, adc: d.adc, pump: d.pump, relay: d.pump, esp: d.esp, wifi: d.esp, sensor: true, ts: null, cnt: 6, secs: 192 };
}
const calOK = () => Number.isFinite(S.cal.dry) && Number.isFinite(S.cal.wet) && S.cal.dry > S.cal.wet;
const pctOf = (a) => (calOK() ? clamp(Math.round((S.cal.dry - a) / (S.cal.dry - S.cal.wet) * 100), 0, 100) : null);
const adcOf = (p) => S.cal.dry - p / 100 * (S.cal.dry - S.cal.wet);
const abnormal = (a) => a <= CFG.adcLow || a >= CFG.adcHigh;
function condition(c) {
  const p = pctOf(c.adc);
  if (p != null) return p < S.cfg.on ? 'Dry' : p < S.cfg.off ? 'Moderate' : 'Moist';
  return c.demo ? DEMO_LABEL[S.scen] + ' (demo)' : 'Needs calibration';
}
function lastText(c) {
  if (c.demo) return DEMO[S.scen].esp ? 'Demo sample, not a real timestamp' : 'Demo: about 18 min ago (simulated)';
  return c.ts ? new Date(c.ts).toLocaleString() : 'Never received';
}
function normalize(r) {
  if (!r || typeof r.adc !== 'number' || r.adc < 0 || r.adc > 4095) return null;
  const n = (v) => (Number.isFinite(v) ? v : null);
  return { adc: Math.round(r.adc), pump: !!r.pump, relay: !!r.relay, rssi: n(r.wifiRssi), sensor: r.sensorOk !== false, count: n(r.pumpCount), secs: n(r.pumpSeconds), updatedAt: n(r.updatedAt) };
}
function applyLiveSnapshot(raw) { const l = normalize(raw); if (!l) return false; const pc = cur(); S.live = l; track(pc); renderAll(); return true; }
async function connectFirebase(cfg) {
  try {
    const [a, d] = await Promise.all([import(CFG.sdk + 'firebase-app.js'), import(CFG.sdk + 'firebase-database.js')]);
    const db = d.getDatabase(a.initializeApp(cfg)), base = 'devices/' + CFG.deviceId;
    S.fb = { db, d, base };
    d.onValue(d.ref(db, base + '/latest'), (s) => applyLiveSnapshot(s.val()), () => { S.fb = null; renderAll(); });
    d.onValue(d.ref(db, base + '/config'), (s) => { const v = s.val(); if (v && Number.isFinite(v.on) && Number.isFinite(v.off)) { S.cfg = { on: v.on, off: v.off, to: Number.isFinite(v.to) ? v.to : S.cfg.to }; syncCfg(); renderAll(); } });
    renderAll(); return true;
  } catch (e) { console.warn('Firebase is not connected', e); return false; }
}
window.AutoAquaGrow = { connectFirebase, applyLiveSnapshot };

/* ---------- activity log ---------- */
function push(msg) { S.log.unshift({ t: Date.now(), msg }); S.log.length = Math.min(S.log.length, 30); }
function track(p) {
  const c = cur(), d = c.demo ? ' (demo)' : '';
  if (p.pump !== c.pump && c.esp) push('Pump turned ' + (c.pump ? 'ON' : 'OFF') + d);
  if (p.esp && !c.esp) push('ESP32 disconnected' + d);
  if (!p.esp && c.esp) push('ESP32 back online' + d);
  const a = condition(p), b = condition(c);
  if (a !== b) { if (b.startsWith('Dry')) push('Soil moisture is too low' + d); if (b.startsWith('Moist')) push('Soil moisture has reached its target' + d); }
  if (abnormal(c.adc) && !abnormal(p.adc)) push('Sensor readings appear abnormal' + d);
}

/* ---------- monitoring ---------- */
function tick(el, pct) {
  if (!calOK()) { el.setAttribute('visibility', 'hidden'); return; }
  const a = clamp(adcOf(pct) / 4095, 0, 1) * Math.PI, x = (n) => (150 - n * Math.cos(a)).toFixed(1), y = (n) => (150 - n * Math.sin(a)).toFixed(1);
  el.setAttribute('x1', x(104)); el.setAttribute('y1', y(104)); el.setAttribute('x2', x(134)); el.setAttribute('y2', y(134)); el.setAttribute('visibility', 'visible');
}
function renderMon() {
  const c = cur(), p = pctOf(c.adc), ab = abnormal(c.adc), d = c.demo ? ' (demo)' : '';
  const chip = $('#modeChip'); chip.textContent = c.demo ? 'DEMO MODE' : 'LIVE DATA'; chip.classList.toggle('ok', !c.demo);
  $('#banner').hidden = !c.demo;
  $('#modeNote').innerHTML = S.fb ? '<b>Firebase connected.</b> Waiting for the first ESP32 reading. Values below are simulated.' : '<b>DEMO MODE.</b> Firebase is not connected, so every value is a simulated example, not an ESP32 reading.';
  $$('#scen button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sc === S.scen)));
  $('#garc').setAttribute('stroke-dasharray', (c.adc / 4095 * 100).toFixed(1) + ' 100');
  $('#gadc').textContent = c.adc;
  tick($('#tOn'), S.cfg.on); tick($('#tOff'), S.cfg.off);
  $('#cond').textContent = condition(c);
  $('#pct').textContent = p == null ? 'No % yet' : p + '%';
  $('#thr').textContent = 'Configured: pump starts below ' + S.cfg.on + '% and stops above ' + S.cfg.off + '%.' + (calOK() ? ' White marks on the gauge show these points.' : ' Add both calibration values to apply them.');
  $('#pumpTxt').textContent = c.esp ? (c.pump ? 'ON' : 'OFF') : 'Unknown';
  $('#pumpLbl').textContent = 'Pump' + d;
  $('#pumpWrap').classList.toggle('run', c.pump && c.esp);
  $('#relay').textContent = c.esp ? (c.relay ? 'Energized' : 'Released') + d : 'Unknown';
  $('#cnt').textContent = (c.cnt == null ? 'Not reported' : c.cnt) + (c.cnt == null ? '' : d);
  $('#dur').textContent = fmtDur(c.secs) + (c.secs == null ? '' : d);
  $('#hESP').textContent = c.esp ? 'Online' + d : 'Offline' + d;
  $('#hWifi').textContent = c.wifi ? 'Connected' + d : c.demo ? 'Disconnected (demo)' : 'Unknown';
  $('#hSensor').textContent = ab ? 'Abnormal reading' : c.sensor ? 'Reading OK' + d : 'Fault reported';
  $('#hLast').textContent = lastText(c);
  const w = $('#stale'), msg = !c.esp ? 'ESP32 is offline. Last data received: ' + lastText(c) + '.' : ab ? 'Sensor readings look abnormal. Check the sensor wiring on GPIO34.' : '';
  w.hidden = !msg; w.textContent = msg;
}

/* ---------- calibration ---------- */
function renderCal() {
  const c = cur(), p = pctOf(c.adc);
  $('#rawNow').textContent = c.adc + (c.demo ? ' (demo)' : '');
  $('#pctNow').textContent = p == null ? 'Enter both values' : p + '%' + (c.demo ? ' (from demo ADC)' : '');
  $('#mk').style.left = (calOK() ? clamp((c.adc - S.cal.wet) / (S.cal.dry - S.cal.wet), 0, 1) * 100 : 50) + '%';
  const live = !c.demo && c.esp && !abnormal(c.adc);
  $('#useDry').disabled = !live; $('#useWet').disabled = !live;
  $('#calNote').textContent = live ? 'The buttons copy the current live reading.' : 'The capture buttons need a live ESP32 reading. Until then, type values from your own measurements.';
}
function readCal() {
  const num = (id) => { const v = $(id).value; return v === '' ? null : Number(v); };
  S.cal = { dry: num('#dry'), wet: num('#wet'), flow: num('#flow') };
  const { dry, wet, flow } = S.cal, bad = (v) => v != null && (v < 0 || v > 4095);
  const e = bad(dry) || bad(wet) ? 'ADC values must be between 0 and 4095.' : dry != null && wet != null && dry <= wet ? 'The dry value must be higher than the wet value.' : flow != null && flow < 0 ? 'Flow rate cannot be negative.' : '';
  $('#calErr').textContent = e;
  if (!e) store.set('cal', S.cal);
  renderAll();
}

/* ---------- analytics (always DEMO until history exists in Firebase) ---------- */
const SERIES = { daily: { n: 24, runs: { 5: 1, 13: 1, 19: 1 }, secs: 96 }, weekly: { n: 7, runs: { 0: 3, 1: 2, 2: 4, 3: 2, 4: 3, 5: 2, 6: 3 }, secs: 612 } };
const sample = (r, i) => Math.round(2350 + Math.sin(i * (r === 'daily' ? 0.55 : 1.1)) * 520 + ((i * 37) % 5) * 18);
const when = (r, i) => { const n = SERIES[r].n, t = new Date(Date.now() - (n - 1 - i) * (r === 'daily' ? 36e5 : 864e5)); return r === 'daily' ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : t.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }); };
function drawChart() {
  const r = S.range, n = SERIES[r].n, W = 640, H = 300, L = 52, T = 14, B = 40, X = (i) => L + i / (n - 1) * (W - L - 10), Y = (v) => T + (1 - (v - 1000) / 2600) * (H - T - B);
  const pts = Array.from({ length: n }, (_, i) => [X(i), Y(sample(r, i))]), line = pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ',' + q[1].toFixed(1)).join('');
  let g = '<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#197A50" stop-opacity=".35"/><stop offset="1" stop-color="#197A50" stop-opacity="0"/></linearGradient></defs>';
  [1000, 1800, 2600, 3400].forEach((v) => { g += '<line x1="' + L + '" x2="' + (W - 10) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="#123d2b22"/><text x="' + (L - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + v + '</text>'; });
  Object.entries(SERIES[r].runs).forEach(([i, k]) => { g += '<rect x="' + (X(+i) - 6) + '" y="' + (H - B - k * 9) + '" width="12" height="' + k * 9 + '" rx="4" fill="#F4B942"/>'; });
  g += '<path d="' + line + 'L' + X(n - 1) + ',' + (H - B) + 'L' + X(0) + ',' + (H - B) + 'Z" fill="url(#cg)"/><path class="ln" d="' + line + '"/>';
  g += '<text x="' + L + '" y="' + (H - 12) + '">' + when(r, 0) + '</text><text x="' + (W - 10) + '" y="' + (H - 12) + '" text-anchor="end">' + when(r, n - 1) + '</text><text x="' + (W / 2) + '" y="' + (H - 12) + '" text-anchor="middle">Gold bars: pump runs</text>';
  g += '<text x="' + (W - 14) + '" y="' + (T + 14) + '" text-anchor="end" style="fill:#8A5A00;font-weight:800">DEMO DATA</text><line id="cl" y1="' + T + '" y2="' + (H - B) + '" stroke="#123d2b66" visibility="hidden"/><circle id="cm" r="6" fill="#fff" stroke="#197A50" stroke-width="3" visibility="hidden"/>';
  const svg = $('#chart'); svg.innerHTML = g;
  const path = svg.querySelector('.ln'), len = path.getTotalLength();
  path.style.strokeDasharray = len; path.style.strokeDashoffset = len;
  requestAnimationFrame(() => { path.style.transition = 'stroke-dashoffset 1.4s ease'; path.style.strokeDashoffset = 0; });
  svg._pts = pts;
}
function hoverChart(e) {
  const svg = $('#chart'), pts = svg._pts; if (!pts) return;
  const rc = svg.getBoundingClientRect(), x = (e.clientX - rc.left) / rc.width * 640;
  let i = 0; pts.forEach((q, k) => { if (Math.abs(q[0] - x) < Math.abs(pts[i][0] - x)) i = k; });
  const v = sample(S.range, i), p = pctOf(v), cm = $('#cm'), cl = $('#cl');
  cm.setAttribute('cx', pts[i][0]); cm.setAttribute('cy', pts[i][1]); cl.setAttribute('x1', pts[i][0]); cl.setAttribute('x2', pts[i][0]);
  cm.setAttribute('visibility', 'visible'); cl.setAttribute('visibility', 'visible');
  $('#chartRead').textContent = when(S.range, i) + ': raw ADC ' + v + (p != null ? ', about ' + p + '% moisture' : ', no % until calibrated') + ' (demo)';
}
function renderAn() {
  const s = SERIES[S.range], f = S.cal.flow, runs = Object.values(s.runs).reduce((a, b) => a + b, 0);
  $('#anNote').textContent = 'DEMO DATA: simulated history for layout preview. Real history appears once the ESP32 stores readings in Firebase.';
  $('#kRuns').textContent = runs + ' (demo)'; $('#kDur').textContent = fmtDur(s.secs) + ' (demo)';
  $('#kWater').textContent = f > 0 ? (s.secs / 60 * f).toFixed(2) + ' L (estimate)' : 'Not available';
  $('#waterNote').textContent = f > 0 ? 'Estimate: run time multiplied by your measured flow rate.' : 'Enter the measured pump flow rate in Calibration to get an estimate.';
}

/* ---------- settings ---------- */
function syncCfg() { $('#onR').value = S.cfg.on; $('#offR').value = S.cfg.off; $('#toR').value = S.cfg.to; cfgLabels(); }
function cfgLabels() { $('#onV').textContent = $('#onR').value; $('#offV').textContent = $('#offR').value; $('#toV').textContent = $('#toR').value; const bad = +$('#onR').value + 10 > +$('#offR').value; $('#cfgErr').textContent = bad ? 'The stop level must be at least 10 points above the start level, or the pump would switch on and off constantly.' : ''; $('#saveCfg').disabled = bad; }
function saveCfg() {
  S.cfg = { on: +$('#onR').value, off: +$('#offR').value, to: +$('#toR').value }; store.set('cfg', S.cfg);
  if (S.fb) { S.fb.d.set(S.fb.d.ref(S.fb.db, S.fb.base + '/config'), S.cfg); $('#cfgNote').textContent = 'Saved to Firebase for the ESP32 to read.'; }
  else $('#cfgNote').textContent = 'Saved in this browser only. Connect Firebase to send settings to the ESP32.';
  renderAll();
}
function pumpTest() {
  const c = cur(), sec = Math.min(S.cfg.to, 10), note = $('#testNote');
  if (S.testing) return;
  if (!c.demo && (!c.esp || abnormal(c.adc))) { note.textContent = 'Test blocked: the ESP32 is offline or the sensor reading is abnormal.'; return; }
  if (S.fb && !c.demo) { S.fb.d.set(S.fb.d.ref(S.fb.db, S.fb.base + '/command'), { pumpTestSec: sec, at: Date.now() }); note.textContent = 'Test command sent. The ESP32 stops the pump after ' + sec + ' s.'; push('Pump test requested, ' + sec + ' s limit'); renderAlerts(); return; }
  S.testing = true; let left = sec; push('Pump test started (demo)'); renderAlerts();
  const t = setInterval(() => { note.textContent = 'Demo test: pump running (simulated), stops in ' + left + ' s.'; if (left-- <= 0) { clearInterval(t); S.testing = false; note.textContent = 'Demo test finished. Pump stopped automatically.'; push('Pump test finished, stopped by timeout (demo)'); renderAlerts(); } }, 1000);
}

/* ---------- notifications ---------- */
function renderAlerts() {
  const c = cur(), lab = condition(c), list = [];
  if (c.demo) list.push(['Info', 'DEMO MODE is on. These notifications describe simulated examples.']);
  if (!c.esp) list.push(['Alert', 'ESP32 disconnected. Last data: ' + lastText(c) + '.']);
  if (abnormal(c.adc)) list.push(['Warning', 'Sensor readings appear abnormal.']);
  if (lab.startsWith('Dry')) list.push(['Warning', 'Soil moisture is too low.']);
  if (c.pump && c.esp) list.push(['Info', 'Pump is ON.']);
  if (lab.startsWith('Moist')) list.push(['Done', 'Soil moisture has reached its target.']);
  if (!list.some((x) => x[0] !== 'Info') && !c.demo) list.push(['Done', 'No issues. Data is up to date.']);
  $('#notes').innerHTML = list.map((x) => '<li><span class="k">' + x[0] + '</span><span>' + x[1] + '</span></li>').join('');
  $('#tl').innerHTML = S.log.length ? S.log.map((e) => '<li><time>' + new Date(e.t).toLocaleString() + '</time>' + e.msg + '</li>').join('') : '<li><span class="note">No activity yet. Events appear here when the pump switches, the soil state changes or the device goes offline. Try the demo scenarios in Monitoring.</span></li>';
}
function renderAll() { renderMon(); renderCal(); renderAn(); renderAlerts(); }

/* ---------- interface ---------- */
function setScen(k) { const pc = cur(); S.scen = k; track(pc); renderAll(); }
let step = 1, timer = null;
const CAPS = ['', 'AC condensation water drips from the unit and is collected.', 'The water is stored in a collection container.', 'The ESP32 reads the capacitive soil sensor on GPIO34.', 'The ESP32 compares the reading with the dry threshold.', 'Soil too dry: the relay switches on the 12V DC pump.', 'Water flows through the irrigation hose to the plant.', 'Target moisture reached: the relay switches the pump off.'];
function setStep(n) { step = n; $$('#steps .st[data-s]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.s === n))); $$('#diag .part').forEach((g) => g.classList.toggle('on', g.dataset.s.split(' ').includes(String(n)))); $('#cap').textContent = n + '. ' + CAPS[n]; }
function stopPlay() { clearInterval(timer); timer = null; $('#play').setAttribute('aria-pressed', 'false'); $('#play').textContent = 'Play all'; }
let deck = 0;
function setDeck(i) { deck = (i + 3) % 3; $$('#deck .pc').forEach((c, k) => c.classList.toggle('on', k === deck)); }

document.addEventListener('DOMContentLoaded', () => {
  $('#yr').textContent = new Date().getFullYear();
  const parts = $('#parts'); for (let i = 0; i < 16; i++) { const s = document.createElement('span'); s.style.left = Math.random() * 100 + '%'; s.style.animationDuration = 7 + Math.random() * 7 + 's'; s.style.animationDelay = -Math.random() * 10 + 's'; parts.appendChild(s); }
  $('#burger').onclick = () => { const o = $('#menu').classList.toggle('open'); $('#burger').setAttribute('aria-expanded', String(o)); };
  $$('#menu a').forEach((a) => a.addEventListener('click', () => { $('#menu').classList.remove('open'); $('#burger').setAttribute('aria-expanded', 'false'); }));
  const spy = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) $$('#menu a').forEach((a) => (a.getAttribute('href') === '#' + e.target.id ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current'))); }), { rootMargin: '-45% 0px -50% 0px' });
  $$('main section').forEach((s) => spy.observe(s));
  const hero = $$('.scene [data-d]'), still = matchMedia('(prefers-reduced-motion: reduce)').matches; let busy = false;
  if (!still) addEventListener('scroll', () => { if (busy) return; busy = true; requestAnimationFrame(() => { const y = Math.min(scrollY, innerHeight); hero.forEach((g) => (g.style.transform = 'translateY(' + y * g.dataset.d + 'px)')); busy = false; }); }, { passive: true });
  $$('#deck .pc').forEach((c, k) => c.addEventListener('click', () => setDeck(k)));
  $('#prev').onclick = () => setDeck(deck - 1); $('#next').onclick = () => setDeck(deck + 1);
  $$('#steps .st[data-s]').forEach((b) => b.addEventListener('click', () => { stopPlay(); setStep(+b.dataset.s); }));
  $('#play').onclick = () => { if (timer) return stopPlay(); $('#play').setAttribute('aria-pressed', 'true'); $('#play').textContent = 'Stop'; setStep(1); timer = setInterval(() => setStep(step % 7 + 1), 2600); };
  $$('#scen button').forEach((b) => b.addEventListener('click', () => setScen(b.dataset.sc)));
  $$('#range button').forEach((b) => b.addEventListener('click', () => { S.range = b.dataset.r; $$('#range button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); drawChart(); renderAn(); }));
  $('#chart').addEventListener('pointermove', hoverChart);
  ['#onR', '#offR', '#toR'].forEach((id) => $(id).addEventListener('input', cfgLabels));
  $('#saveCfg').onclick = saveCfg;
  ['#dry', '#wet', '#flow'].forEach((id) => $(id).addEventListener('input', readCal));
  $('#useDry').onclick = () => { $('#dry').value = cur().adc; readCal(); }; $('#useWet').onclick = () => { $('#wet').value = cur().adc; readCal(); };
  const dlg = $('#dlg'); $('#testBtn').onclick = () => { $('#dlgS').textContent = Math.min(S.cfg.to, 10); dlg.showModal(); };
  $('#dlgNo').onclick = () => dlg.close(); $('#dlgOk').onclick = () => { dlg.close(); pumpTest(); };
  ['dry', 'wet', 'flow'].forEach((k) => { if (S.cal[k] != null) $('#' + k).value = S.cal[k]; });
  syncCfg(); setStep(1); setDeck(0); drawChart(); renderAll();
  setInterval(() => { if (S.live) renderAll(); }, 15000);
  import('./firebase-config.js').then((m) => m.default && connectFirebase(m.default)).catch(() => { /* no config file: stay in DEMO MODE */ });
});
addEventListener('load', () => setTimeout(() => $('#loader').classList.add('done'), 600));
