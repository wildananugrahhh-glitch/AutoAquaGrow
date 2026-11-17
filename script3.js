'use strict';

/* AutoAquaGrow - live Firebase monitoring and real history */
const CFG = {
  staleMs: 15000,
  adcLow: 50,
  adcHigh: 4045,
  sdk: 'https://www.gstatic.com/firebasejs/10.12.2/'
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('aag.' + k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('aag.' + k, JSON.stringify(v)); } catch (_) {} }
};

const S = {
  live: { sensor: null, pump: null, device: null },
  historySensor: [],
  historyPump: [],
  fb: null,
  range: 'daily',
  cal: store.get('cal', { dry: 1934, wet: 1050, flow: null }),
  cfg: store.get('cfg', { on: 30, off: 40, to: 60 }),
  connectionError: false
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmtDur = (s) => {
  if (!Number.isFinite(s)) return '—';
  const v = Math.max(0, Math.floor(s));
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), sec = v % 60;
  return h ? `${h} hr ${m} min` : m ? `${m} min ${sec} sec` : `${sec} sec`;
};
const validNum = (v) => Number.isFinite(Number(v));
const calOK = () => Number.isFinite(S.cal.dry) && Number.isFinite(S.cal.wet) && S.cal.dry > S.cal.wet;
const abnormal = (a) => !Number.isFinite(a) || a <= CFG.adcLow || a >= CFG.adcHigh;

function currentState() {
  const s = S.live.sensor || {};
  const p = S.live.pump || {};
  const d = S.live.device || {};
  const lastSeen = Number(d.lastSeen || 0);
  const online = lastSeen > 0 && Date.now() - lastSeen <= CFG.staleMs && d.wifiConnected !== false;
  const adc = Number(s.adc);
  const moisture = Number(s.kelembapan);
  const pumpStatus = String(p.status || '').toUpperCase();
  return {
    adc: Number.isFinite(adc) ? adc : null,
    moisture: Number.isFinite(moisture) ? moisture : null,
    soilStatus: String(s.status || ''),
    pump: pumpStatus === 'ON',
    pumpKnown: pumpStatus === 'ON' || pumpStatus === 'OFF',
    pumpStartedAt: Number(p.startedAt || 0),
    online,
    wifi: online && d.wifiConnected !== false,
    lastSeen,
    sensorAvailable: online && Number.isFinite(adc) && Number.isFinite(moisture),
    rssi: validNum(d.rssi) ? Number(d.rssi) : null
  };
}

function moisturePercent(c) {
  if (Number.isFinite(c.moisture)) return clamp(Math.round(c.moisture), 0, 100);
  if (calOK() && Number.isFinite(c.adc)) {
    return clamp(Math.round((S.cal.dry - c.adc) / (S.cal.dry - S.cal.wet) * 100), 0, 100);
  }
  return null;
}

function soilLabel(c) {
  const p = moisturePercent(c);
  if (p == null) return 'No reading';
  if (p < 30) return 'Dry';
  if (p < 70) return 'Moderate';
  return 'Moist';
}

function applyHistory(raw, kind) {
  const list = raw && typeof raw === 'object' ? Object.entries(raw).map(([key, v]) => ({ key, ...v })) : [];
  const cleaned = list.map(x => ({
    ...x,
    timestamp: Number(x.timestamp || 0),
    adc: Number(x.adc),
    kelembapan: Number(x.kelembapan),
    durationSeconds: Number(x.durationSeconds || 0),
    status: String(x.status || '').toUpperCase()
  })).filter(x => x.timestamp > 0).sort((a,b) => a.timestamp - b.timestamp);
  if (kind === 'sensor') S.historySensor = cleaned;
  else S.historyPump = cleaned;
  renderAll();
}

async function connectFirebase(cfg) {
  try {
    const [appSdk, dbSdk] = await Promise.all([
      import(CFG.sdk + 'firebase-app.js'),
      import(CFG.sdk + 'firebase-database.js')
    ]);
    const app = appSdk.initializeApp(cfg);
    const db = dbSdk.getDatabase(app);
    S.fb = { db, d: dbSdk };
    const watch = (path, cb) => dbSdk.onValue(dbSdk.ref(db, path), snap => cb(snap.val()), err => {
      console.error('Firebase read error at ' + path, err);
      S.connectionError = true;
      renderAll();
    });
    watch('AutoAquaGrow/sensor', value => { S.live.sensor = value || null; renderAll(); });
    watch('AutoAquaGrow/pompa', value => { S.live.pump = value || null; renderAll(); });
    watch('AutoAquaGrow/device', value => { S.live.device = value || null; renderAll(); });
    const sensorQuery = dbSdk.query(dbSdk.ref(db, 'AutoAquaGrow/history/sensor'), dbSdk.limitToLast(3500));
    const pumpQuery = dbSdk.query(dbSdk.ref(db, 'AutoAquaGrow/history/pompa'), dbSdk.limitToLast(1000));
    dbSdk.onValue(sensorQuery, snap => applyHistory(snap.val(), 'sensor'), err => console.error('Sensor history read error', err));
    dbSdk.onValue(pumpQuery, snap => applyHistory(snap.val(), 'pump'), err => console.error('Pump history read error', err));
    S.connectionError = false;
    renderAll();
    console.log('AutoAquaGrow Firebase connected.');
    return true;
  } catch (e) {
    console.error('Firebase connection failed:', e);
    S.connectionError = true;
    renderAll();
    return false;
  }
}

window.AutoAquaGrow = { connectFirebase };

/* Monitoring */
function renderMon() {
  const c = currentState();
  const p = moisturePercent(c);
  const chip = $('#modeChip');
  chip.textContent = c.online ? 'LIVE DATA' : 'ESP32 OFFLINE';
  chip.classList.toggle('ok', c.online);
  chip.classList.toggle('offline', !c.online);

  $('#garc').setAttribute('stroke-dasharray', (c.adc == null ? 0 : c.adc / 4095 * 100).toFixed(1) + ' 100');
  $('#gadc').textContent = c.adc == null ? '—' : Math.round(c.adc);
  $('#cond').textContent = c.online ? soilLabel(c) : 'No data';
  $('#pct').textContent = p == null || !c.online ? '—%' : p + '%';
  $('#thr').textContent = 'Pump control is managed locally by the ESP32 program.';
  $('#pumpTxt').textContent = c.online && c.pumpKnown ? (c.pump ? 'ON' : 'OFF') : '—';
  $('#pumpWrap').classList.toggle('run', c.online && c.pumpKnown && c.pump);
  $('#hESP').textContent = c.online ? 'Online' : 'Offline';
  $('#hWifi').textContent = c.online && c.wifi ? 'Connected' : 'Disconnected / No signal';
  $('#hSensor').textContent = !c.online ? 'No data' : abnormal(c.adc) ? 'Check sensor' : 'Reading OK';
  $('#hLast').textContent = c.lastSeen ? new Date(c.lastSeen).toLocaleString() : 'No recent heartbeat';
  const msg = !c.online ? 'ESP32 has not sent a heartbeat recently. Live readings are unavailable.' : abnormal(c.adc) ? 'Sensor reading appears outside the expected ADC range. Check the sensor and wiring.' : '';
  $('#stale').hidden = !msg;
  $('#stale').textContent = msg;
}

/* Calibration UI retained; values are stored in this browser. */
function renderCal() {
  const c = currentState();
  const p = moisturePercent(c);
  $('#rawNow').textContent = c.adc == null ? 'No live reading' : Math.round(c.adc);
  $('#pctNow').textContent = p == null ? 'Waiting for calibration/live data' : p + '%';
  $('#mk').style.left = calOK() && c.adc != null ? clamp((c.adc - S.cal.wet) / (S.cal.dry - S.cal.wet), 0, 1) * 100 + '%' : '50%';
  const live = c.online && !abnormal(c.adc);
  $('#useDry').disabled = !live;
  $('#useWet').disabled = !live;
  $('#calNote').textContent = live ? 'Capture buttons copy the current live ADC reading.' : 'Capture buttons become available when ESP32 sends a valid live reading.';
}
function readCal() {
  const num = id => $(id).value === '' ? null : Number($(id).value);
  const next = { dry: num('#dry'), wet: num('#wet'), flow: num('#flow') };
  const badADC = v => v != null && (v < 0 || v > 4095);
  const err = badADC(next.dry) || badADC(next.wet) ? 'ADC values must be between 0 and 4095.' : next.dry != null && next.wet != null && next.dry <= next.wet ? 'Dry value must be higher than wet value.' : next.flow != null && next.flow < 0 ? 'Flow rate cannot be negative.' : '';
  $('#calErr').textContent = err;
  if (!err) { S.cal = next; store.set('cal', S.cal); }
  renderAll();
}

/* Analytics: all points and pump statistics come from Firebase history. */
function bucketHistory(range) {
  const now = Date.now();
  const spans = { hourly: 3600000, daily: 86400000, weekly: 604800000 };
  const span = spans[range];
  const start = now - span;
  const data = S.historySensor.filter(x => x.timestamp >= start && x.timestamp <= now && Number.isFinite(x.adc));
  if (range === 'hourly') return data.map(x => ({ x: x.timestamp, y: x.adc, label: new Date(x.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) }));
  const bucketSize = range === 'daily' ? 3600000 : 86400000;
  const buckets = new Map();
  data.forEach(x => {
    const key = Math.floor(x.timestamp / bucketSize) * bucketSize;
    const item = buckets.get(key) || { sum: 0, count: 0 };
    item.sum += x.adc; item.count++;
    buckets.set(key, item);
  });
  return [...buckets.entries()].sort((a,b) => a[0]-b[0]).map(([t,v]) => ({
    x: t, y: Math.round(v.sum / v.count),
    label: range === 'daily' ? new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : new Date(t).toLocaleDateString([], {weekday:'short'})
  }));
}
function rangeStart() {
  const span = S.range === 'hourly' ? 3600000 : S.range === 'daily' ? 86400000 : 604800000;
  return Date.now() - span;
}
function pumpStats() {
  const start = rangeStart();
  const events = S.historyPump.filter(x => x.timestamp >= start && x.timestamp <= Date.now());
  const runs = events.filter(x => x.status === 'ON').length;
  let seconds = events.filter(x => x.status === 'OFF').reduce((sum,x) => sum + (Number.isFinite(x.durationSeconds) ? x.durationSeconds : 0), 0);
  const c = currentState();
  if (c.online && c.pump && c.pumpStartedAt > 0) seconds += Math.max(0, Math.floor((Date.now() - c.pumpStartedAt) / 1000));
  return { runs, seconds };
}
function drawChart() {
  const svg = $('#chart');
  const points = bucketHistory(S.range);
  const W = 640, H = 300, L = 55, R = 12, T = 18, B = 48;
  const yMin = 0, yMax = 4095;
  const X = i => points.length <= 1 ? (W + L - R) / 2 : L + i / (points.length - 1) * (W - L - R);
  const Y = v => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
  let g = '<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#197A50" stop-opacity=".32"/><stop offset="1" stop-color="#197A50" stop-opacity="0"/></linearGradient></defs>';
  [0,1024,2048,3072,4095].forEach(v => {
    g += `<line x1="${L}" x2="${W-R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#123d2b22"/><text x="${L-8}" y="${Y(v)+4}" text-anchor="end">${v}</text>`;
  });
  if (points.length >= 1) {
    const line = points.map((p,i) => `${i ? 'L':'M'}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    if (points.length > 1) g += `<path d="${line} L${X(points.length-1)},${H-B} L${X(0)},${H-B} Z" fill="url(#cg)"/>`;
    g += `<path class="ln" d="${line}" fill="none"/>`;
    points.forEach((p,i) => { if (points.length <= 30 || i % Math.ceil(points.length/30) === 0) g += `<circle cx="${X(i)}" cy="${Y(p.y)}" r="3.5" fill="#197A50"/>`; });
    g += `<text x="${L}" y="${H-12}">${points[0].label}</text><text x="${W-R}" y="${H-12}" text-anchor="end">${points[points.length-1].label}</text>`;
  } else {
    g += `<text x="${W/2}" y="${H/2-5}" text-anchor="middle" style="font-size:16px;font-weight:700">No historical readings yet</text><text x="${W/2}" y="${H/2+20}" text-anchor="middle">The first point is saved after the next 3-minute interval.</text>`;
  }
  svg.innerHTML = g;
  svg._points = points.map((p,i) => ({...p, px:X(i), py:Y(p.y)}));
  $('#chartRead').textContent = points.length ? `${points.length} real sensor record(s) in this period. Move over the chart to inspect a reading.` : 'Waiting for real Firebase history. No sample data is displayed.';
}
function hoverChart(e) {
  const svg = $('#chart'), points = svg._points || [];
  if (!points.length) return;
  const rc = svg.getBoundingClientRect();
  const x = (e.clientX - rc.left) / rc.width * 640;
  let best = points[0];
  points.forEach(p => { if (Math.abs(p.px-x) < Math.abs(best.px-x)) best = p; });
  const pct = calOK() ? clamp(Math.round((S.cal.dry-best.y)/(S.cal.dry-S.cal.wet)*100),0,100) : null;
  $('#chartRead').textContent = `${new Date(best.x).toLocaleString()} · ADC ${best.y}${pct == null ? '' : ` · ${pct}% moisture`}`;
}
function renderAn() {
  const labels = { hourly: 'Hourly · last 60 minutes', daily: 'Daily · last 24 hours', weekly: 'Weekly · last 7 days' };
  $('#anNote').textContent = labels[S.range] + '. Only readings actually saved in Firebase are shown.';
  const stats = pumpStats();
  $('#kRuns').textContent = String(stats.runs);
  $('#kDur').textContent = fmtDur(stats.seconds);
  const flow = Number(S.cal.flow);
  $('#kWater').textContent = flow > 0 ? (stats.seconds / 60 * flow).toFixed(2) + ' L' : 'Not configured';
  $('#waterNote').textContent = flow > 0 ? 'Estimate based on measured pump flow rate.' : 'Water estimate requires a measured pump flow rate (L/min).';
}

/* Existing educational interactions */
let step = 1, timer = null, deck = 0;
const CAPS = ['', 'AC condensation water drips from the unit and is collected.', 'The water is stored in a collection container.', 'The ESP32 reads the capacitive soil sensor on GPIO34.', 'The ESP32 compares the reading with the dry threshold.', 'Soil too dry: the relay switches on the 12V DC pump.', 'Water flows through the irrigation hose to the plant.', 'Target moisture reached: the relay switches the pump off.'];
function setStep(n) {
  step = n;
  $$('#steps .st[data-s]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.s === n)));
  $$('#diag .part').forEach(g => g.classList.toggle('on', g.dataset.s.split(' ').includes(String(n))));
  $('#cap').textContent = n + '. ' + CAPS[n];
}
function stopPlay() { clearInterval(timer); timer = null; $('#play').setAttribute('aria-pressed','false'); $('#play').textContent = 'Play all'; }
function setDeck(i) { deck = (i+3)%3; $$('#deck .pc').forEach((c,k)=>c.classList.toggle('on',k===deck)); }
function renderAlerts() {
  const c = currentState(), list = [];
  if (!c.online) list.push(['Alert','ESP32 is offline or has not sent a recent heartbeat.']);
  else if (abnormal(c.adc)) list.push(['Warning','Sensor reading appears abnormal.']);
  else if (soilLabel(c) === 'Dry') list.push(['Warning','Soil moisture is low.']);
  else list.push(['Status','Live device data is up to date.']);
  if (c.online && c.pumpKnown && c.pump) list.push(['Info','Pump is currently ON.']);
  $('#notes').innerHTML = list.map(x=>`<li><span class="k">${x[0]}</span><span>${x[1]}</span></li>`).join('');
  const recent = S.historyPump.slice(-12).reverse();
  $('#tl').innerHTML = recent.length ? recent.map(e=>`<li><time>${new Date(e.timestamp).toLocaleString()}</time>Pump ${e.status}${e.status==='OFF' && e.durationSeconds ? ` · ran for ${fmtDur(e.durationSeconds)}` : ''}</li>`).join('') : '<li><span class="note">No pump events have been recorded yet.</span></li>';
}
function renderAll() { renderMon(); renderCal(); drawChart(); renderAn(); renderAlerts(); }

/* Initialization */
document.addEventListener('DOMContentLoaded', () => {
  $('#yr').textContent = new Date().getFullYear();
  const parts = $('#parts');
  for (let i=0;i<16;i++) { const s=document.createElement('span'); s.style.left=Math.random()*100+'%'; s.style.animationDuration=7+Math.random()*7+'s'; s.style.animationDelay=-Math.random()*10+'s'; parts.appendChild(s); }
  $('#burger').onclick=()=>{ const open=$('#menu').classList.toggle('open'); $('#burger').setAttribute('aria-expanded',String(open)); };
  $$('#menu a').forEach(a=>a.addEventListener('click',()=>{ $('#menu').classList.remove('open'); $('#burger').setAttribute('aria-expanded','false'); }));
  const spy=new IntersectionObserver(es=>es.forEach(e=>{ if(e.isIntersecting) $$('#menu a').forEach(a=>a.getAttribute('href')==='#'+e.target.id?a.setAttribute('aria-current','true'):a.removeAttribute('aria-current')); }),{rootMargin:'-45% 0px -50% 0px'});
  $$('main section').forEach(s=>spy.observe(s));
  const hero=$$('.scene [data-d]'), still=matchMedia('(prefers-reduced-motion: reduce)').matches; let busy=false;
  if(!still) addEventListener('scroll',()=>{ if(busy)return; busy=true; requestAnimationFrame(()=>{const y=Math.min(scrollY,innerHeight);hero.forEach(g=>g.style.transform='translateY('+y*g.dataset.d+'px)');busy=false;});},{passive:true});
  $$('#deck .pc').forEach((c,k)=>c.addEventListener('click',()=>setDeck(k)));
  $('#prev').onclick=()=>setDeck(deck-1); $('#next').onclick=()=>setDeck(deck+1);
  $$('#steps .st[data-s]').forEach(b=>b.addEventListener('click',()=>{stopPlay();setStep(+b.dataset.s);}));
  $('#play').onclick=()=>{if(timer)return stopPlay();$('#play').setAttribute('aria-pressed','true');$('#play').textContent='Stop';setStep(1);timer=setInterval(()=>setStep(step%7+1),2600);};
  $$('#range button').forEach(b=>b.addEventListener('click',()=>{S.range=b.dataset.r;$$('#range button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));drawChart();renderAn();}));
  $('#chart').addEventListener('pointermove',hoverChart);
  ['#dry','#wet','#flow'].forEach(id=>$(id).addEventListener('input',readCal));
  $('#useDry').onclick=()=>{$('#dry').value=currentState().adc;readCal();};
  $('#useWet').onclick=()=>{$('#wet').value=currentState().adc;readCal();};
  ['dry','wet','flow'].forEach(k=>{if(S.cal[k]!=null)$('#'+k).value=S.cal[k];});
  renderAll(); setStep(1); setDeck(0);
  import('./firebase-config.js').then(m=>{if(m.default)connectFirebase(m.default);else throw new Error('firebase-config.js must export the Firebase configuration as default.');}).catch(e=>{console.error('Firebase config not loaded:',e);S.connectionError=true;renderAll();$('#hESP').textContent='Waiting for Firebase';});
  setInterval(()=>{renderMon();renderAn();renderAlerts();},5000);
});
addEventListener('load',()=>setTimeout(()=>$('#loader').classList.add('done'),600));
