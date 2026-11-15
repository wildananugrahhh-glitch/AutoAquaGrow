
'use strict';

/*
  AutoAquaGrow - Firebase Realtime Database Integration

  Firebase structure:
  AutoAquaGrow/
    sensor/
      adc
      kelembapan
      status
    pompa/
      status

  ESP32 remains responsible for automatic irrigation.
  Website is for monitoring only.
*/

const CFG = {
  staleMs: 120000,
  adcLow: 50,
  adcHigh: 4045,
  sdk: 'https://www.gstatic.com/firebasejs/10.12.2/'
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('aag.' + k);
      return v ? JSON.parse(v) : d;
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('aag.' + k, JSON.stringify(v));
    } catch (e) {}
  }
};

const S = {
  live: null,
  fb: null,
  scen: 'moderate',
  range: 'daily',
  cal: store.get('cal', {
    dry: null,
    wet: null,
    flow: null
  }),
  cfg: store.get('cfg', {
    on: 30,
    off: 40,
    to: 60
  }),
  log: [],
  testing: false
};

const DEMO = {
  dry: { adc: 3020, pump: true, esp: true },
  moderate: { adc: 2380, pump: false, esp: true },
  moist: { adc: 1600, pump: false, esp: true },
  offline: { adc: 2380, pump: false, esp: false }
};

const DEMO_LABEL = {
  dry: 'Dry',
  moderate: 'Moderate',
  moist: 'Moist',
  offline: 'Moderate'
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const fmtDur = (s) =>
  s == null
    ? 'Not reported'
    : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';


/* ---------- DATA LAYER ---------- */

function normalize(r) {
  if (!r || !r.sensor || !r.pompa) return null;

  const adc = Number(r.sensor.adc);
  const moisture = Number(r.sensor.kelembapan);

  const pumpStatus = String(
    r.pompa.status ?? ''
  ).trim().toUpperCase();

  if (
    !Number.isFinite(adc) ||
    adc < 0 ||
    adc > 4095
  ) return null;

  if (
    !Number.isFinite(moisture) ||
    moisture < 0 ||
    moisture > 100
  ) return null;

  return {
    adc: Math.round(adc),
    moisture: Math.round(moisture),
    soilStatus: String(r.sensor.status ?? ''),
    pump: pumpStatus === 'ON',
    pumpKnown:
      pumpStatus === 'ON' ||
      pumpStatus === 'OFF',
    sensor: true,

    // Website records the time it received this snapshot.
    // This is not the ESP32's own timestamp.
    updatedAt: Date.now(),

    relay: null,
    rssi: null,
    count: null,
    secs: null
  };
}

function cur() {
  const l = S.live;

  if (l) {
    const age = Date.now() - l.updatedAt;
    const ok = age <= CFG.staleMs;

    return {
      demo: false,
      adc: l.adc,
      moisture: l.moisture,
      soilStatus: l.soilStatus,
      pump: l.pump && ok,
      pumpKnown: l.pumpKnown,
      relay: null,
      esp: ok,
      wifi: false,
      sensor: l.sensor,
      ts: l.updatedAt,
      cnt: null,
      secs: null
    };
  }

  const d = DEMO[S.scen];

  return {
    demo: true,
    adc: d.adc,
    moisture: null,
    soilStatus: '',
    pump: d.pump,
    pumpKnown: true,
    relay: d.pump,
    esp: d.esp,
    wifi: d.esp,
    sensor: true,
    ts: null,
    cnt: 6,
    secs: 192
  };
}

const calOK = () =>
  Number.isFinite(S.cal.dry) &&
  Number.isFinite(S.cal.wet) &&
  S.cal.dry > S.cal.wet;

const pctOf = (a, supplied) =>
  Number.isFinite(supplied)
    ? clamp(Math.round(supplied), 0, 100)
    : calOK()
      ? clamp(
          Math.round(
            (S.cal.dry - a) /
            (S.cal.dry - S.cal.wet) * 100
          ),
          0,
          100
        )
      : null;

const adcOf = (p) =>
  S.cal.dry -
  p / 100 * (S.cal.dry - S.cal.wet);

const abnormal = (a) =>
  a <= CFG.adcLow || a >= CFG.adcHigh;

function condition(c) {
  const p = pctOf(c.adc, c.moisture);

  if (p != null) {
    return p < S.cfg.on
      ? 'Dry'
      : p < S.cfg.off
        ? 'Moderate'
        : 'Moist';
  }

  return c.demo
    ? DEMO_LABEL[S.scen] + ' (demo)'
    : 'Needs calibration';
}

function lastText(c) {
  if (c.demo) {
    return DEMO[S.scen].esp
      ? 'Demo sample, not a real timestamp'
      : 'Demo: about 18 min ago (simulated)';
  }

  return c.ts
    ? new Date(c.ts).toLocaleString() + ' (received by website)'
    : 'Never received';
}

function applyLiveSnapshot(raw) {
  const l = normalize(raw);

  if (!l) {
    console.warn('Firebase data is incomplete or invalid:', raw);
    return false;
  }

  const previous = cur();

  S.live = l;

  track(previous);
  renderAll();

  return true;
}

async function connectFirebase(cfg) {
  try {
    const [a, d] = await Promise.all([
      import(CFG.sdk + 'firebase-app.js'),
      import(CFG.sdk + 'firebase-database.js')
    ]);

    const app = a.initializeApp(cfg);
    const db = d.getDatabase(app);

    S.fb = {
      db,
      d,
      base: 'AutoAquaGrow'
    };

    d.onValue(
      d.ref(db, 'AutoAquaGrow'),
      (snapshot) => {
        const data = snapshot.val();

        if (!applyLiveSnapshot(data)) {
          console.warn('Waiting for valid ESP32 data.');
        }
      },
      (error) => {
        console.error('Firebase read error:', error);
        renderAll();
      }
    );

    renderAll();

    console.log('AutoAquaGrow Firebase connected.');

    return true;

  } catch (e) {
    console.error('Firebase connection failed:', e);
    return false;
  }
}

window.AutoAquaGrow = {
  connectFirebase,
  applyLiveSnapshot
};


/* ---------- ACTIVITY LOG ---------- */

function push(msg) {
  S.log.unshift({
    t: Date.now(),
    msg
  });

  S.log.length = Math.min(S.log.length, 30);
}

function track(previous) {
  const current = cur();

  const d = current.demo ? ' (demo)' : '';

  if (
    previous.pump !== current.pump &&
    current.esp &&
    previous.pumpKnown !== false
  ) {
    push(
      'Pump turned ' +
      (current.pump ? 'ON' : 'OFF') + d
    );
  }

  if (previous.esp && !current.esp) {
    push('ESP32 data became stale or disconnected');
  }

  if (!previous.esp && current.esp) {
    push('ESP32 data received again');
  }

  const a = condition(previous);
  const b = condition(current);

  if (a !== b) {
    if (b.startsWith('Dry')) {
      push('Soil moisture is too low' + d);
    }

    if (b.startsWith('Moist')) {
      push('Soil moisture has reached its target' + d);
    }
  }

  if (abnormal(current.adc) && !abnormal(previous.adc)) {
    push('Sensor readings appear abnormal' + d);
  }
}


/* ---------- MONITORING ---------- */

function tick(el, pct) {
  if (!calOK()) {
    el.setAttribute('visibility', 'hidden');
    return;
  }

  const a =
    clamp(adcOf(pct) / 4095, 0, 1) * Math.PI;

  const x = (n) =>
    (150 - n * Math.cos(a)).toFixed(1);

  const y = (n) =>
    (150 - n * Math.sin(a)).toFixed(1);

  el.setAttribute('x1', x(104));
  el.setAttribute('y1', y(104));
  el.setAttribute('x2', x(134));
  el.setAttribute('y2', y(134));
  el.setAttribute('visibility', 'visible');
}

function renderMon() {
  const c = cur();
  const p = pctOf(c.adc, c.moisture);
  const ab = abnormal(c.adc);
  const d = c.demo ? ' (demo)' : '';

  const chip = $('#modeChip');

  chip.textContent = c.demo
    ? 'DEMO MODE'
    : 'LIVE DATA';

  chip.classList.toggle('ok', !c.demo);

  $('#banner').hidden = !c.demo;

  $('#modeNote').innerHTML = c.demo
    ? '<b>DEMO MODE.</b> Firebase is not connected, so every value is a simulated example, not an ESP32 reading.'
    : '<b>LIVE DATA.</b> Values are received from the AutoAquaGrow ESP32 through Firebase.';

  $$('#scen button').forEach((b) => {
    b.setAttribute(
      'aria-pressed',
      String(b.dataset.sc === S.scen)
    );
  });

  $('#garc').setAttribute(
    'stroke-dasharray',
    (c.adc / 4095 * 100).toFixed(1) + ' 100'
  );

  $('#gadc').textContent = c.adc;

  tick($('#tOn'), S.cfg.on);
  tick($('#tOff'), S.cfg.off);

  $('#cond').textContent =
    !c.demo && c.soilStatus
      ? c.soilStatus
      : condition(c);

  $('#pct').textContent =
    p == null ? 'No % yet' : p + '%';

  $('#thr').textContent = c.demo
    ? 'Demo thresholds: starts below ' +
      S.cfg.on + '% and stops above ' +
      S.cfg.off + '%.'
    : 'Pump control is managed locally by the ESP32 program.';

  $('#pumpTxt').textContent =
    c.esp && c.pumpKnown
      ? (c.pump ? 'ON' : 'OFF')
      : 'Unknown';

  $('#pumpLbl').textContent = 'Pump' + d;

  $('#pumpWrap').classList.toggle(
    'run',
    c.pump && c.esp && c.pumpKnown
  );

  $('#relay').textContent = 'Not reported';

  $('#cnt').textContent = 'Not reported';
  $('#dur').textContent = 'Not reported';

  $('#hESP').textContent =
    c.esp ? 'Online' + d : 'Offline / No recent data';

  $('#hWifi').textContent =
    c.demo
      ? (c.wifi ? 'Connected (demo)' : 'Disconnected (demo)')
      : 'Not reported';

  $('#hSensor').textContent =
    ab
      ? 'Abnormal reading'
      : c.sensor
        ? 'Reading OK' + d
        : 'Fault reported';

  $('#hLast').textContent = lastText(c);

  const w = $('#stale');

  const msg = !c.esp
    ? 'No recent ESP32 data. The website cannot confirm the current device status.'
    : ab
      ? 'Sensor readings look abnormal. Check the sensor wiring on GPIO34.'
      : '';

  w.hidden = !msg;
  w.textContent = msg;
}


/* ---------- CALIBRATION ---------- */

function renderCal() {
  const c = cur();
  const p = pctOf(c.adc, c.moisture);

  $('#rawNow').textContent =
    c.adc + (c.demo ? ' (demo)' : '');

  $('#pctNow').textContent =
    p == null
      ? 'Enter both values'
      : p + '%' + (c.demo ? ' (from demo ADC)' : '');

  $('#mk').style.left =
    (calOK()
      ? clamp(
          (c.adc - S.cal.wet) /
          (S.cal.dry - S.cal.wet),
          0,
          1
        ) * 100
      : 50
    ) + '%';

  const live =
    !c.demo &&
    c.esp &&
    !abnormal(c.adc);

  $('#useDry').disabled = !live;
  $('#useWet').disabled = !live;

  $('#calNote').textContent = live
    ? 'The buttons copy the current live ADC reading.'
    : 'Capture buttons need a live ESP32 reading. You can enter your own measured ADC values.';
}

function readCal() {
  const num = (id) => {
    const v = $(id).value;
    return v === '' ? null : Number(v);
  };

  S.cal = {
    dry: num('#dry'),
    wet: num('#wet'),
    flow: num('#flow')
  };

  const { dry, wet, flow } = S.cal;

  const bad = (v) =>
    v != null && (v < 0 || v > 4095);

  const e =
    bad(dry) || bad(wet)
      ? 'ADC values must be between 0 and 4095.'
      : dry != null && wet != null && dry <= wet
        ? 'The dry value must be higher than the wet value.'
        : flow != null && flow < 0
          ? 'Flow rate cannot be negative.'
          : '';

  $('#calErr').textContent = e;

  if (!e) {
    store.set('cal', S.cal);
  }

  renderAll();
}


/* ---------- ANALYTICS: DEMO ONLY ---------- */

const SERIES = {
  daily: {
    n: 24,
    runs: { 5: 1, 13: 1, 19: 1 },
    secs: 96
  },
  weekly: {
    n: 7,
    runs: {
      0: 3, 1: 2, 2: 4,
      3: 2, 4: 3, 5: 2, 6: 3
    },
    secs: 612
  }
};

const sample = (r, i) =>
  Math.round(
    2350 +
    Math.sin(i * (r === 'daily' ? 0.55 : 1.1)) * 520 +
    ((i * 37) % 5) * 18
  );

const when = (r, i) => {
  const n = SERIES[r].n;

  const t = new Date(
    Date.now() -
    (n - 1 - i) *
    (r === 'daily' ? 36e5 : 864e5)
  );

  return r === 'daily'
    ? t.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })
    : t.toLocaleDateString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short'
      });
};

function drawChart() {
  const r = S.range;
  const n = SERIES[r].n;

  const W = 640;
  const H = 300;
  const L = 52;
  const T = 14;
  const B = 40;

  const X = (i) =>
    L + i / (n - 1) * (W - L - 10);

  const Y = (v) =>
    T + (1 - (v - 1000) / 2600) *
    (H - T - B);

  const pts = Array.from(
    { length: n },
    (_, i) => [X(i), Y(sample(r, i))]
  );

  const line = pts.map((q, i) =>
    (i ? 'L' : 'M') +
    q[0].toFixed(1) + ',' +
    q[1].toFixed(1)
  ).join('');

  let g =
    '<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#197A50" stop-opacity=".35"/>' +
    '<stop offset="1" stop-color="#197A50" stop-opacity="0"/>' +
    '</linearGradient></defs>';

  [1000, 1800, 2600, 3400].forEach((v) => {
    g +=
      '<line x1="' + L +
      '" x2="' + (W - 10) +
      '" y1="' + Y(v) +
      '" y2="' + Y(v) +
      '" stroke="#123d2b22"/>' +
      '<text x="' + (L - 8) +
      '" y="' + (Y(v) + 4) +
      '" text-anchor="end">' + v + '</text>';
  });

  Object.entries(SERIES[r].runs).forEach(([i, k]) => {
    g +=
      '<rect x="' + (X(+i) - 6) +
      '" y="' + (H - B - k * 9) +
      '" width="12" height="' + k * 9 +
      '" rx="4" fill="#F4B942"/>';
  });

  g +=
    '<path d="' + line +
    'L' + X(n - 1) + ',' + (H - B) +
    'L' + X(0) + ',' + (H - B) +
    'Z" fill="url(#cg)"/>' +
    '<path class="ln" d="' + line + '"/>';

  g +=
    '<text x="' + L + '" y="' + (H - 12) + '">' +
    when(r, 0) + '</text>' +
    '<text x="' + (W - 10) +
    '" y="' + (H - 12) +
    '" text-anchor="end">' +
    when(r, n - 1) + '</text>' +
    '<text x="' + (W / 2) +
    '" y="' + (H - 12) +
    '" text-anchor="middle">Gold bars: pump runs</text>';

  g +=
    '<text x="' + (W - 14) +
    '" y="' + (T + 14) +
    '" text-anchor="end" style="fill:#8A5A00;font-weight:800">DEMO DATA</text>' +
    '<line id="cl" y1="' + T +
    '" y2="' + (H - B) +
    '" stroke="#123d2b66" visibility="hidden"/>' +
    '<circle id="cm" r="6" fill="#fff" stroke="#197A50" stroke-width="3" visibility="hidden"/>';

  const svg = $('#chart');

  svg.innerHTML = g;

  const path = svg.querySelector('.ln');
  const len = path.getTotalLength();

  path.style.strokeDasharray = len;
  path.style.strokeDashoffset = len;

  requestAnimationFrame(() => {
    path.style.transition =
      'stroke-dashoffset 1.4s ease';

    path.style.strokeDashoffset = 0;
  });

  svg._pts = pts;
}

function hoverChart(e) {
  const svg = $('#chart');
  const pts = svg._pts;

  if (!pts) return;

  const rc = svg.getBoundingClientRect();

  const x =
    (e.clientX - rc.left) / rc.width * 640;

  let i = 0;

  pts.forEach((q, k) => {
    if (
      Math.abs(q[0] - x) <
      Math.abs(pts[i][0] - x)
    ) i = k;
  });

  const v = sample(S.range, i);
  const p = pctOf(v);

  const cm = $('#cm');
  const cl = $('#cl');

  cm.setAttribute('cx', pts[i][0]);
  cm.setAttribute('cy', pts[i][1]);

  cl.setAttribute('x1', pts[i][0]);
  cl.setAttribute('x2', pts[i][0]);

  cm.setAttribute('visibility', 'visible');
  cl.setAttribute('visibility', 'visible');

  $('#chartRead').textContent =
    when(S.range, i) +
    ': raw ADC ' + v +
    (p != null
      ? ', about ' + p + '% moisture'
      : ', no % until calibrated') +
    ' (demo)';
}

function renderAn() {
  const s = SERIES[S.range];
  const f = S.cal.flow;

  const runs = Object.values(s.runs)
    .reduce((a, b) => a + b, 0);

  $('#anNote').textContent =
    'DEMO DATA: simulated history for layout preview. Real history is not yet stored by the ESP32.';

  $('#kRuns').textContent = runs + ' (demo)';
  $('#kDur').textContent = fmtDur(s.secs) + ' (demo)';

  $('#kWater').textContent =
    f > 0
      ? (s.secs / 60 * f).toFixed(2) + ' L (estimate)'
      : 'Not available';

  $('#waterNote').textContent =
    f > 0
      ? 'Estimate: run time multiplied by your measured flow rate.'
      : 'Enter the measured pump flow rate in Calibration to get an estimate.';
}


/* ---------- SETTINGS: LOCAL PREVIEW ONLY ---------- */

function syncCfg() {
  $('#onR').value = S.cfg.on;
  $('#offR').value = S.cfg.off;
  $('#toR').value = S.cfg.to;

  cfgLabels();
}

function cfgLabels() {
  $('#onV').textContent = $('#onR').value;
  $('#offV').textContent = $('#offR').value;
  $('#toV').textContent = $('#toR').value;

  const bad =
    +$('#onR').value + 10 >
    +$('#offR').value;

  $('#cfgErr').textContent = bad
    ? 'The stop level must be at least 10 points above the start level.'
    : '';

  $('#saveCfg').disabled = bad;
}

function saveCfg() {
  S.cfg = {
    on: +$('#onR').value,
    off: +$('#offR').value,
    to: +$('#toR').value
  };

  store.set('cfg', S.cfg);

  $('#cfgNote').textContent =
    'Saved in this browser only. ESP32 settings are unchanged.';

  renderAll();
}

function pumpTest() {
  const c = cur();
  const sec = Math.min(S.cfg.to, 10);
  const note = $('#testNote');

  if (S.testing) return;

  if (!c.demo) {
    note.textContent =
      'Pump test is unavailable in live mode. The ESP32 does not receive test commands from this website.';
    return;
  }

  S.testing = true;

  let left = sec;

  push('Pump test started (demo)');
  renderAlerts();

  const t = setInterval(() => {
    note.textContent =
      'Demo test: pump running (simulated), stops in ' +
      left + ' s.';

    if (left-- <= 0) {
      clearInterval(t);

      S.testing = false;

      note.textContent =
        'Demo test finished. Pump stopped automatically.';

      push('Pump test finished, stopped by timeout (demo)');

      renderAlerts();
    }
  }, 1000);
}


/* ---------- NOTIFICATIONS ---------- */

function renderAlerts() {
  const c = cur();
  const lab = condition(c);

  const list = [];

  if (c.demo) {
    list.push([
      'Info',
      'DEMO MODE is on. These notifications describe simulated examples.'
    ]);
  }

  if (!c.esp) {
    list.push([
      'Alert',
      'No recent ESP32 data. The latest device state cannot be confirmed.'
    ]);
  }

  if (abnormal(c.adc)) {
    list.push([
      'Warning',
      'Sensor readings appear abnormal.'
    ]);
  }

  if (lab.startsWith('Dry')) {
    list.push([
      'Warning',
      'Soil moisture is too low.'
    ]);
  }

  if (c.pump && c.esp && c.pumpKnown) {
    list.push([
      'Info',
      'Pump is ON.'
    ]);
  }

  if (lab.startsWith('Moist')) {
    list.push([
      'Done',
      'Soil moisture has reached its target.'
    ]);
  }

  if (
    !list.some((x) => x[0] !== 'Info') &&
    !c.demo &&
    c.esp
  ) {
    list.push([
      'Done',
      'No issues. Data is up to date.'
    ]);
  }

  $('#notes').innerHTML = list.map((x) =>
    '<li><span class="k">' +
    x[0] +
    '</span><span>' +
    x[1] +
    '</span></li>'
  ).join('');

  $('#tl').innerHTML = S.log.length
    ? S.log.map((e) =>
        '<li><time>' +
        new Date(e.t).toLocaleString() +
        '</time>' +
        e.msg +
        '</li>'
      ).join('')
    : '<li><span class="note">No activity yet. Events appear here when the pump switches, the soil state changes or the device goes offline.</span></li>';
}

function renderAll() {
  renderMon();
  renderCal();
  renderAn();
  renderAlerts();
}


/* ---------- INTERFACE ---------- */

function setScen(k) {
  const pc = cur();

  S.scen = k;

  track(pc);
  renderAll();
}

let step = 1;
let timer = null;

const CAPS = [
  '',
  'AC condensation water drips from the unit and is collected.',
  'The water is stored in a collection container.',
  'The ESP32 reads the capacitive soil sensor on GPIO34.',
  'The ESP32 compares the reading with the dry threshold.',
  'Soil too dry: the relay switches on the 12V DC pump.',
  'Water flows through the irrigation hose to the plant.',
  'Target moisture reached: the relay switches the pump off.'
];

function setStep(n) {
  step = n;

  $$('#steps .st[data-s]').forEach((b) =>
    b.setAttribute(
      'aria-pressed',
      String(+b.dataset.s === n)
    )
  );

  $$('#diag .part').forEach((g) =>
    g.classList.toggle(
      'on',
      g.dataset.s.split(' ').includes(String(n))
    )
  );

  $('#cap').textContent = n + '. ' + CAPS[n];
}

function stopPlay() {
  clearInterval(timer);
  timer = null;

  $('#play').setAttribute('aria-pressed', 'false');
  $('#play').textContent = 'Play all';
}

let deck = 0;

function setDeck(i) {
  deck = (i + 3) % 3;

  $$('#deck .pc').forEach((c, k) =>
    c.classList.toggle('on', k === deck)
  );
}



/* ---------- INITIALIZATION ---------- */

document.addEventListener('DOMContentLoaded', () => {

  $('#yr').textContent = new Date().getFullYear();

  const parts = $('#parts');

  for (let i = 0; i < 16; i++) {
    const s = document.createElement('span');

    s.style.left = Math.random() * 100 + '%';
    s.style.animationDuration =
      7 + Math.random() * 7 + 's';
    s.style.animationDelay =
      -Math.random() * 10 + 's';

    parts.appendChild(s);
  }

  $('#burger').onclick = () => {
    const o = $('#menu').classList.toggle('open');

    $('#burger').setAttribute(
      'aria-expanded',
      String(o)
    );
  };

  $$('#menu a').forEach((a) =>
    a.addEventListener('click', () => {
      $('#menu').classList.remove('open');

      $('#burger').setAttribute(
        'aria-expanded',
        'false'
      );
    })
  );

  const spy = new IntersectionObserver((es) =>
    es.forEach((e) => {
      if (e.isIntersecting) {
        $$('#menu a').forEach((a) =>
          a.getAttribute('href') === '#' + e.target.id
            ? a.setAttribute('aria-current', 'true')
            : a.removeAttribute('aria-current')
        );
      }
    }),
    { rootMargin: '-45% 0px -50% 0px' }
  );

  $$('main section').forEach((s) => spy.observe(s));

  const hero = $$('.scene [data-d]');
  const still = matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  let busy = false;

  if (!still) {
    addEventListener('scroll', () => {
      if (busy) return;

      busy = true;

      requestAnimationFrame(() => {
        const y = Math.min(scrollY, innerHeight);

        hero.forEach((g) =>
          g.style.transform =
            'translateY(' + y * g.dataset.d + 'px)'
        );

        busy = false;
      });
    }, { passive: true });
  }

  $$('#deck .pc').forEach((c, k) =>
    c.addEventListener('click', () => setDeck(k))
  );

  $('#prev').onclick = () => setDeck(deck - 1);
  $('#next').onclick = () => setDeck(deck + 1);

  $$('#steps .st[data-s]').forEach((b) =>
    b.addEventListener('click', () => {
      stopPlay();
      setStep(+b.dataset.s);
    })
  );

  $('#play').onclick = () => {
    if (timer) return stopPlay();

    $('#play').setAttribute('aria-pressed', 'true');
    $('#play').textContent = 'Stop';

    setStep(1);

    timer = setInterval(
      () => setStep(step % 7 + 1),
      2600
    );
  };

  $$('#scen button').forEach((b) =>
    b.addEventListener('click', () =>
      setScen(b.dataset.sc)
    )
  );

  $$('#range button').forEach((b) =>
    b.addEventListener('click', () => {
      S.range = b.dataset.r;

      $$('#range button').forEach((x) =>
        x.setAttribute(
          'aria-pressed',
          String(x === b)
        )
      );

      drawChart();
      renderAn();
    })
  );

  $('#chart').addEventListener(
    'pointermove',
    hoverChart
  );

  ['#onR', '#offR', '#toR'].forEach((id) =>
    $(id).addEventListener('input', cfgLabels)
  );

  $('#saveCfg').onclick = saveCfg;

  ['#dry', '#wet', '#flow'].forEach((id) =>
    $(id).addEventListener('input', readCal)
  );

  $('#useDry').onclick = () => {
    $('#dry').value = cur().adc;
    readCal();
  };

  $('#useWet').onclick = () => {
    $('#wet').value = cur().adc;
    readCal();
  };

  const dlg = $('#dlg');

  $('#testBtn').onclick = () => {
    $('#dlgS').textContent =
      Math.min(S.cfg.to, 10);

    dlg.showModal();
  };

  $('#dlgNo').onclick = () => dlg.close();

  $('#dlgOk').onclick = () => {
    dlg.close();
    pumpTest();
  };

  ['dry', 'wet', 'flow'].forEach((k) => {
    if (S.cal[k] != null) {
      $('#' + k).value = S.cal[k];
    }
  });

  syncCfg();
  setStep(1);
  setDeck(0);
  drawChart();
  renderAll();

  // Firebase connection
  import('./firebase-config.js')
    .then((m) => {
      if (m.default) {
        connectFirebase(m.default);
      }
    })
    .catch((e) => {
      console.warn(
        'Firebase config not found. Staying in DEMO MODE.',
        e
      );
    });

  // Refresh stale-data status every 15 seconds.
  setInterval(() => {
    if (S.live) {
      renderAll();
    }
  }, 15000);

});

addEventListener('load', () =>
  setTimeout(
    () => $('#loader').classList.add('done'),
    600
  )
);
