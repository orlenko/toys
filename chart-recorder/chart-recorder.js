/**
 * <chart-recorder> — circular chart recorder with fading revolution history.
 *
 * The chart turns once per `period`; the pen traces the value (min at the
 * inner ring, max at the outer ring). Instead of putting on a fresh chart each
 * revolution, the trace stays on the paper and is coloured by age: it starts
 * at the first of `colors` at the pen, shifts through the gradient and fades
 * out over `revolutions` turns, then is dropped.
 *
 * Styles: 'classic' (paper chart, pen on a swinging arm) and 'scope'
 * (dark instrument; `motion: 'dial'` turns the chart, 'sweep' turns the pen).
 *
 *   <script type="module" src="chart-recorder.js"></script>
 *   <chart-recorder style-name="classic" period="86400000" max="200" unit="°F"></chart-recorder>
 *
 *   const rec = document.querySelector('chart-recorder');
 *   rec.configure({ revolutions: 10, alertAt: 160 });
 *   rec.push(128.4);              // timestamp defaults to clock()
 *   rec.push(130.1, Date.now());  // timestamps must not go backwards
 *   rec.push(null);               // breaks the line
 *   rec.setData([{ t, v }, ...]); // bulk load, e.g. backfill history
 *   rec.clear();                  // put on a fresh chart
 *
 * Labels use Barlow Condensed, Barlow, IBM Plex Mono and JetBrains Mono when
 * the page has loaded them (override with the `fonts` option).
 */

const MIN = 6e4, HOUR = 3.6e6, DAY = 864e5;
const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export const formatShort = (v) => {
  const a = Math.abs(v);
  return a >= 1e5 ? Math.round(v / 1e3) + 'k' : a >= 1e3 ? +(v / 1e3).toFixed(1) + 'k' : String(Math.round(v * 10) / 10);
};

// Geometry is in units of the half-size of the element (Rb = 1).
// R: chart edge, Rg: max ring, r0: min ring, D: pen pivot distance (arm length = D).
const STYLES = {
  classic: {
    geo: { R: 0.87, Rg: 0.87 * 0.9, r0: 0.87 * 0.3, D: 0.87 * 1.05, arc: true },
    colors: ['#2c5a3c', '#6a3d8f', '#a8466e', '#c9803a'],
  },
  scope: {
    geo: { R: 0.965, Rg: 0.84, r0: 0.25, D: 0.965, arc: false },
    colors: ['#3fd6e8', '#7f8cff', '#c17bff', '#ff7ac8'],
  },
};

const DEFAULTS = {
  style: 'classic',            // 'classic' | 'scope'
  motion: 'dial',              // scope only: 'dial' (chart turns) | 'sweep' (pen turns)
  period: DAY,                 // ms per revolution
  divisions: 24,               // labelled time divisions per revolution (24 = hours, 60 = minutes/seconds)
  min: 0,
  max: 100,
  unit: '',
  chartName: 'CHART 209',
  chartLabel: null,            // e.g. '24 HOUR'; derived from period when null
  subLabel: null,              // small label under 0 on 60-division charts; derived when null
  alertAt: null,               // value of the dashed alert ring; null hides it
  revolutions: 10,             // turns kept on the chart, including the one just drawn
  gradientMode: 'smooth',      // 'smooth' (by exact age) | 'stepped' (one colour per turn)
  colors: null,                // gradient stops, newest → oldest; style default when null
  opacity: [1, 0.12],          // opacity at the newest / oldest end of the trace
  resolution: 720,             // stored points per revolution
  utc: false,                  // align divisions to UTC instead of local time
  clock: () => Date.now(),     // time source; swap for simulated or replayed time
  formatTick: formatShort,     // value labels on the chart
  formatValue: null,           // scope centre readout; formatTick when null
  fonts: {
    display: '"Barlow Condensed", "Arial Narrow", sans-serif',
    body: '"Barlow", "Helvetica Neue", Arial, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    scope: '"JetBrains Mono", ui-monospace, Menlo, monospace',
  },
};

const ATTRS = {
  'style-name': ['style', String],
  motion: ['motion', String],
  period: ['period', Number],
  divisions: ['divisions', Number],
  min: ['min', Number],
  max: ['max', Number],
  unit: ['unit', String],
  'alert-at': ['alertAt', Number],
  revolutions: ['revolutions', Number],
  'gradient-mode': ['gradientMode', String],
  'chart-name': ['chartName', String],
};

// ---- colour helpers (OKLab interpolation keeps the gradient even) ----

let parseCtx;
function parseColor(css) {
  parseCtx ??= document.createElement('canvas').getContext('2d');
  parseCtx.fillStyle = '#000';
  parseCtx.fillStyle = css;
  const s = parseCtx.fillStyle;
  if (s[0] === '#') return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  return s.match(/[\d.]+/g).slice(0, 3).map((n) => n / 255);
}
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
function toOklab(rgb) {
  const [r, g, b] = rgb.map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.round(clamp(toSrgb(c)) * 255));
}
function gradientAt(stops, t) {
  if (stops.length === 1) return fromOklab(stops[0]);
  const x = clamp(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return fromOklab(stops[i].map((v, k) => v + (stops[i + 1][k] - v) * f));
}
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${+a.toFixed(3)})`;

// ---------------------------------------------------------------------------

export class ChartRecorder extends HTMLElement {
  static observedAttributes = Object.keys(ATTRS);

  #o = { ...DEFAULTS, fonts: { ...DEFAULTS.fonts } };
  #s = [];          // { t, v, x, y }; x/y are chart coordinates (Rb = 1), v null = gap
  #head = 0;        // first live index; pruned samples are compacted lazily
  #start = null;    // when the chart was put on
  #lut = [];        // trace stroke styles by age, newest → oldest
  #inkRgb = [0, 0, 0]; // newest gradient colour, used for the pen tip
  #cv;
  #ctx;
  #grid = document.createElement('canvas');
  #gctx = this.#grid.getContext('2d');
  #gridDirty = true;
  #W = 0;
  #H = 0;
  #S = 0;
  #dpr = 1;
  #raf = 0;
  #ro;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { display: block; position: relative; aspect-ratio: 1 / 1; max-width: 100%; }
        canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
      </style>
      <canvas part="canvas"></canvas>`;
    this.#cv = root.querySelector('canvas');
    this.#ctx = this.#cv.getContext('2d');
    this.#buildLut();
  }

  connectedCallback() {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'img');
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Circular chart recorder');
    this.#ro = new ResizeObserver(() => this.#layout());
    this.#ro.observe(this);
    document.fonts?.ready.then(() => (this.#gridDirty = true));
    document.fonts?.addEventListener?.('loadingdone', this.#fontsLoaded);
    this.#layout();
    this.#raf = requestAnimationFrame(this.#tick);
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.#raf);
    this.#ro?.disconnect();
    document.fonts?.removeEventListener?.('loadingdone', this.#fontsLoaded);
  }

  attributeChangedCallback(name, _old, value) {
    if (value == null) return;
    const [key, cast] = ATTRS[name];
    this.configure({ [key]: cast(value) });
  }

  // ---- public API ----

  /** Current options (copy). */
  get options() {
    return { ...this.#o, fonts: { ...this.#o.fonts } };
  }

  /** When the current chart was put on (first sample or last clear()). */
  get chartStart() {
    return this.#start;
  }

  /** Latest recorded value, or null. */
  get value() {
    return this.#s[this.#s.length - 1]?.v ?? null;
  }

  /** Resolved trace colours newest → oldest (one per level), e.g. for a legend. */
  get palette() {
    return this.#lut.map((l) => l.color);
  }

  /** Merge options; returns the element. */
  configure(options = {}) {
    const fonts = options.fonts ? { ...this.#o.fonts, ...options.fonts } : this.#o.fonts;
    Object.assign(this.#o, options, { fonts });
    const o = this.#o;
    o.revolutions = Math.max(1, Math.floor(o.revolutions) || 1);
    o.resolution = Math.max(1, o.resolution);
    this.#buildLut();
    this.#reproject();
    this.#layout();
    return this;
  }

  /** Record a value. null/NaN breaks the line; samples older than the last one are ignored. */
  push(value, t = this.#o.clock()) {
    const v = value == null || !Number.isFinite(+value) ? null : +value;
    const s = this.#s;
    const last = s[s.length - 1];
    if (last && t < last.t) return this;
    if (this.#start == null) {
      this.#start = t;
      this.#gridDirty = true;
    }
    const p = this.#project({ t, v });
    // Coalesce samples that arrive faster than the stored resolution.
    const prev = s[s.length - 2];
    if (prev && s.length - 1 > this.#head && last.v != null && v != null && t - prev.t < this.#o.period / this.#o.resolution) {
      s[s.length - 1] = p;
    } else {
      s.push(p);
    }
    return this;
  }

  /** Replace all data with [{ t, v }] (any order). */
  setData(samples) {
    this.#s = [];
    this.#head = 0;
    this.#start = null;
    [...samples].sort((a, b) => a.t - b.t).forEach((p) => this.push(p.v, p.t));
    this.#gridDirty = true;
    return this;
  }

  /** Remove all history and put on a fresh chart now. */
  clear() {
    this.setData([]);
    this.#start = this.#o.clock();
    return this;
  }

  /** Recorded samples as [{ t, v }] with t >= since. */
  getSamples(since = -Infinity) {
    const out = [];
    for (let i = this.#head; i < this.#s.length; i++) {
      const p = this.#s[i];
      if (p.t >= since) out.push({ t: p.t, v: p.v });
    }
    return out;
  }

  // ---- geometry ----

  get #style() {
    return STYLES[this.#o.style] ?? STYLES.classic;
  }
  get #g() {
    return this.#style.geo;
  }
  #colors() {
    return this.#o.colors ?? this.#style.colors;
  }

  /** Revolution phase in [0, 1), aligned to local (or UTC) clock time. */
  #phase(ms) {
    const local = this.#o.utc ? ms : ms - new Date(ms).getTimezoneOffset() * MIN;
    const x = local / this.#o.period;
    return x - Math.floor(x);
  }
  #frac(v) {
    const { min, max } = this.#o;
    return clamp((v - min) / (max - min || 1));
  }
  #vToR(v) {
    const g = this.#g;
    return g.r0 + this.#frac(v) * (g.Rg - g.r0);
  }
  // Angle of the pen tip on its arc for radius r (pivot at distance D, arm length D).
  #psi(r) {
    return Math.acos(clamp(r / (2 * this.#g.D), -1, 1));
  }
  #ang(phase, r) {
    const g = this.#g;
    return TAU * phase + (g.arc ? this.#psi(r) - this.#psi(g.Rg) : 0);
  }
  #xy(t, v) {
    const r = this.#vToR(v);
    const a = this.#ang(this.#phase(t), r);
    return [r * Math.sin(a), -r * Math.cos(a)];
  }
  #project(p) {
    if (p.v == null) return { t: p.t, v: null, x: 0, y: 0 };
    const [x, y] = this.#xy(p.t, p.v);
    return { t: p.t, v: p.v, x, y };
  }
  #reproject() {
    this.#s = this.#s.slice(this.#head).map((p) => this.#project(p));
    this.#head = 0;
  }

  // ---- colours ----

  #alertFrac() {
    return this.#o.alertAt == null ? null : this.#frac(this.#o.alertAt);
  }
  // Scope's value colouring: cyan at the bottom of the scale, amber near the alert level, red above it.
  #valueColor(f, alpha) {
    const af = this.#alertFrac();
    if (af != null && f >= af) return `hsla(4, 95%, 62%, ${alpha})`;
    const k = clamp(f / (af ?? 1));
    return `hsla(${188 - 145 * k ** 1.4}, 90%, ${58 + 4 * k}%, ${alpha})`;
  }
  /** One stroke style per age level, newest → oldest: { color, glow, t } with t in [0, 1]. */
  #buildLut() {
    const o = this.#o;
    const N = o.revolutions;
    const stops = this.#colors().map((c) => toOklab(parseColor(c)));
    const [a0, a1] = o.opacity;
    const levels = o.gradientMode === 'stepped' ? N : 128;
    this.#lut = [];
    for (let i = 0; i < levels; i++) {
      const t = levels > 1 ? i / (levels - 1) : 0;
      const rgb = gradientAt(stops, t);
      const alpha = a0 + (a1 - a0) * t;
      this.#lut.push({ color: rgba(rgb, alpha), glow: rgba(rgb, alpha * 0.16), t });
    }
    this.#inkRgb = gradientAt(stops, 0);
    this.#gridDirty = true;
  }

  // ---- loop ----

  #fontsLoaded = () => (this.#gridDirty = true);

  #layout() {
    if (!this.isConnected) return;
    const box = this.getBoundingClientRect();
    this.#dpr = window.devicePixelRatio || 1;
    this.#W = box.width;
    this.#H = box.height;
    this.#S = Math.max(1, Math.min(box.width, box.height));
    this.#cv.width = Math.round(box.width * this.#dpr);
    this.#cv.height = Math.round(box.height * this.#dpr);
    this.#grid.width = this.#grid.height = Math.round(this.#S * this.#dpr);
    this.#gridDirty = true;
  }

  #tick = () => {
    this.#raf = requestAnimationFrame(this.#tick);
    if (!this.#S) return;
    const now = this.#o.clock();
    this.#prune(now);
    if (this.#gridDirty) {
      this.#gridDirty = false;
      this.#o.style === 'scope' ? this.#gridScope(now) : this.#gridClassic(now);
    }
    const live = this.value;
    this.#o.style === 'scope' ? this.#frameScope(now, live) : this.#frameClassic(now, live);
  };

  #prune(now) {
    const keep = this.#o.revolutions * this.#o.period;
    const s = this.#s;
    // Keep one sample past the cutoff so the oldest segment still has a start point.
    while (this.#head < s.length - 1 && now - s[this.#head + 1].t > keep) this.#head++;
    if (this.#head > 2048 && this.#head > s.length / 2) {
      this.#s = s.slice(this.#head);
      this.#head = 0;
    }
  }

  // ---- trace ----

  /** Bucket the trace into one Path2D per age level (index into #lut). */
  #buildPaths(now) {
    const o = this.#o;
    const s = this.#s;
    const P = o.period;
    const step = P / o.resolution;
    const levels = this.#lut.length;
    const span = o.revolutions * P;
    const paths = new Map();
    let lastKey = null;

    const keyFor = (t) => {
      const u = Math.max(0, now - t) / span;
      return u >= 1 ? null : Math.min(levels - 1, Math.floor(u * levels));
    };

    // Long gaps between samples are split so the line follows the chart's arcs.
    const run = (a, b) => {
      const dt = b.t - a.t;
      const n = dt > step * 1.5 ? Math.ceil(dt / step) : 1;
      let x0 = a.x, y0 = a.y;
      for (let k = 1; k <= n; k++) {
        const [x1, y1] = k === n ? [b.x, b.y] : this.#xy(a.t + (dt * k) / n, a.v + ((b.v - a.v) * k) / n);
        const key = keyFor(a.t + (dt * (k - 1)) / n);
        if (key == null) {
          lastKey = null;
        } else {
          let path = paths.get(key);
          if (!path) paths.set(key, (path = new Path2D()));
          if (key !== lastKey) path.moveTo(x0, y0);
          path.lineTo(x1, y1);
          lastKey = key;
        }
        x0 = x1;
        y0 = y1;
      }
    };

    for (let i = this.#head + 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i];
      if (a.v == null || b.v == null) lastKey = null;
      else run(a, b);
    }
    // The pen keeps drawing at the last value until the next sample arrives.
    const last = s[s.length - 1];
    if (last && last.v != null && now > last.t) {
      const [x, y] = this.#xy(now, last.v);
      run(last, { t: now, v: last.v, x, y });
    }
    return paths;
  }

  #drawTrace(c, now, Rb, scope) {
    const paths = this.#buildPaths(now);
    const g = this.#g;
    c.save();
    c.scale(Rb, Rb);
    c.lineCap = 'round';
    c.lineJoin = 'round';

    // Line width tapers from the newest to the oldest trace.
    const [w0, w1] = scope
      ? [Math.max(1.3, Rb * 0.0045), Math.max(1, Rb * 0.0035)]
      : [Math.max(1.2, g.R * Rb * 0.0045), Math.max(0.9, g.R * Rb * 0.0034)];
    // Oldest first, so newer turns paint on top.
    const keys = [...paths.keys()].sort((a, b) => b - a);

    // Scope: soft glow under the most recent turn only.
    if (scope) {
      const firstTurn = this.#lut.length / this.#o.revolutions;
      c.lineWidth = Math.max(4, Rb * 0.016) / Rb;
      for (const k of keys) {
        if (k >= firstTurn) continue;
        c.strokeStyle = this.#lut[k].glow;
        c.stroke(paths.get(k));
      }
    }
    for (const k of keys) {
      const { color, t } = this.#lut[k];
      c.lineWidth = (w0 + (w1 - w0) * t) / Rb;
      c.strokeStyle = color;
      c.stroke(paths.get(k));
    }
    c.restore();
  }

  // ---- labels ----

  #chartLabel() {
    const { chartLabel, period, divisions } = this.#o;
    if (chartLabel != null) return chartLabel;
    return period === DAY ? '24 HOUR' : period === HOUR ? '60 MINUTE' : period === MIN ? '60 SECOND' : `${divisions} DIV`;
  }
  #subLabel() {
    const { subLabel, period } = this.#o;
    if (subLabel != null) return subLabel;
    return period === HOUR ? 'MIN' : period === MIN ? 'SEC' : '';
  }
  #fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      ...(this.#o.utc ? { timeZone: 'UTC' } : {}),
    });
  }

  // ---- classic ----

  #gridClassic(now) {
    const o = this.#o;
    const g = this.#gctx;
    const S = this.#S, dpr = this.#dpr, Rb = S / 2;
    const R = this.#g.R * Rb, Rg = this.#g.Rg * Rb, r0 = this.#g.r0 * Rb;
    const div = o.divisions;
    const beta = (p) => (TAU * p) / div;
    const ang = (p, r) => this.#ang(p / div, r / Rb);
    const pt = (a, r) => [r * Math.sin(a), -r * Math.cos(a)];
    const F = o.fonts;
    g.setTransform(dpr, 0, 0, dpr, (S * dpr) / 2, (S * dpr) / 2);
    g.clearRect(-S, -S, 2 * S, 2 * S);
    const grid = '#7c86b6', paper = '#efe8d6';
    g.fillStyle = paper;
    g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fill();
    g.strokeStyle = grid;
    for (let k = 0; k <= 50; k++) {
      g.lineWidth = k % 5 === 0 ? 0.9 : 0.35;
      g.globalAlpha = k % 5 === 0 ? 0.95 : 0.7;
      g.beginPath(); g.arc(0, 0, r0 + (k / 50) * (Rg - r0), 0, TAU); g.stroke();
    }
    const sub = div <= 24 ? 4 : 2, majorEvery = div <= 24 ? sub : 10;
    for (let m = 0; m < div * sub; m++) {
      const p = m / sub, maj = m % majorEvery === 0, mid = m % 2 === 0;
      g.lineWidth = maj ? 0.9 : mid ? 0.5 : 0.3;
      g.globalAlpha = maj ? 0.95 : 0.65;
      g.beginPath();
      for (let i = 0; i <= 30; i++) {
        const r = r0 + (i / 30) * (Rg - r0);
        const [x, y] = pt(ang(p, r), r);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    g.lineWidth = 1.2;
    g.beginPath(); g.arc(0, 0, Rg + (R - Rg) * 0.12, 0, TAU); g.stroke();

    g.fillStyle = grid; g.textAlign = 'center'; g.textBaseline = 'middle';
    const rl = (Rg + R) / 2 + 1, big = Math.round(R * 0.062), small = Math.round(R * 0.03);
    const label = (p, text, under) => {
      g.save(); g.rotate(beta(p));
      g.font = `600 ${big}px ${F.display}`;
      g.fillText(text, 0, -rl);
      if (under) { g.font = `600 ${small}px ${F.display}`; g.fillText(under, 0, -rl + R * 0.052); }
      g.restore();
    };
    if (div === 24) {
      for (let hr = 0; hr < 24; hr++) label(hr, String(hr % 12 === 0 ? 12 : hr % 12), hr % 12 === 0 ? (hr === 0 ? 'MIDNIGHT' : 'NOON') : null);
    } else {
      const every = div >= 60 ? 5 : 1;
      for (let p = 0; p < div; p += every) label(p, String(p), p === 0 ? this.#subLabel() : null);
    }

    g.font = `500 ${Math.round(R * 0.028)}px ${F.mono}`;
    for (const q of [0, 0.25, 0.5, 0.75]) {
      for (let i = 0; i <= 10; i++) {
        const v = o.min + ((o.max - o.min) * i) / 10, r = this.#vToR(v) * Rb, a = ang(q * div, r) + 0.025;
        const [x, y] = pt(a, r);
        g.save(); g.translate(x, y); g.rotate(a);
        const t = o.formatTick(v), w = g.measureText(t).width;
        g.fillStyle = paper; g.fillRect(-w / 2 - 1, -R * 0.018, w + 2, R * 0.036);
        g.fillStyle = grid; g.fillText(t, 0, 0);
        g.restore();
      }
    }
    g.fillStyle = paper;
    g.beginPath(); g.arc(0, 0, r0 * 0.97, 0, TAU); g.fill();
    g.fillStyle = grid;
    g.font = `700 ${Math.round(R * 0.05)}px ${F.display}`;
    g.fillText(o.chartName, 0, -r0 * 0.55);
    g.font = `600 ${Math.round(R * 0.032)}px ${F.display}`;
    g.fillText(`${o.formatTick(o.min)} – ${o.formatTick(o.max)} ${o.unit}  ·  ${this.#chartLabel()}`, 0, -r0 * 0.33);
    g.fillText('DATE ON', 0, r0 * 0.38);
    const d = new Date(this.#start ?? now);
    g.font = `italic 500 ${Math.round(R * 0.04)}px ${F.body}`;
    g.fillStyle = '#3b3f55';
    g.fillText(`${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(2)}  ${this.#fmtTime(d.getTime()).slice(0, div === 60 ? 8 : 5)}`, 0, r0 * 0.56);
  }

  #frameClassic(now, live) {
    const c = this.#ctx;
    const S = this.#S, dpr = this.#dpr, Rb = S / 2;
    const geo = this.#g;
    const R = geo.R * Rb, Rg = geo.Rg * Rb, D = geo.D * Rb;
    c.setTransform(dpr, 0, 0, dpr, (this.#W * dpr) / 2, (this.#H * dpr) / 2);
    c.clearRect(-this.#W, -this.#H, 2 * this.#W, 2 * this.#H);
    let gr = c.createRadialGradient(0, 0, R * 0.9, 0, 0, Rb);
    gr.addColorStop(0, '#0b0c0d'); gr.addColorStop(0.55, '#1c1f21'); gr.addColorStop(0.85, '#2a2e30'); gr.addColorStop(1, '#0d0e0f');
    c.fillStyle = gr; c.beginPath(); c.arc(0, 0, Rb - 1, 0, TAU); c.fill();
    c.fillStyle = '#d9cfb6'; c.beginPath(); c.arc(0, 0, R * 1.035, 0, TAU); c.fill();

    c.save();
    c.rotate(this.#psi(geo.Rg) - TAU * this.#phase(now));
    c.drawImage(this.#grid, -S / 2, -S / 2, S, S);
    if (this.#o.alertAt != null) {
      c.setLineDash([3, 4]); c.strokeStyle = 'rgba(176,48,43,.6)'; c.lineWidth = 1;
      c.beginPath(); c.arc(0, 0, this.#vToR(this.#o.alertAt) * Rb, 0, TAU); c.stroke(); c.setLineDash([]);
    }
    this.#drawTrace(c, now, Rb, false);
    c.restore();

    gr = c.createRadialGradient(0, 0, R * 0.93, 0, 0, R * 1.04);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.28)');
    c.fillStyle = gr; c.beginPath(); c.arc(0, 0, R * 1.04, 0, TAU); c.fill();

    // Pen arm, pivoting above the chart.
    const rr = (live == null ? geo.r0 : this.#vToR(live)) * Rb;
    const a0 = this.#psi(rr / Rb);
    const tx = rr * Math.sin(a0), ty = -rr * Math.cos(a0), px = 0, py = -D;
    const a = Math.atan2(ty - py, tx - px), len = Math.hypot(tx - px, ty - py);
    c.save(); c.translate(px, py); c.rotate(a);
    c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = R * 0.03; c.shadowOffsetY = R * 0.012;
    gr = c.createLinearGradient(0, -R * 0.03, 0, R * 0.03);
    gr.addColorStop(0, '#e9ecee'); gr.addColorStop(0.5, '#9ea4a8'); gr.addColorStop(1, '#d4d8da');
    c.fillStyle = gr;
    c.beginPath(); c.moveTo(0, -R * 0.028); c.lineTo(len - R * 0.05, -R * 0.011); c.lineTo(len - R * 0.05, R * 0.011); c.lineTo(0, R * 0.028); c.closePath(); c.fill();
    c.shadowColor = 'transparent';
    c.fillStyle = '#5c6266'; c.fillRect(len - R * 0.055, -R * 0.016, R * 0.045, R * 0.032);
    c.fillStyle = rgba(this.#inkRgb, 1);
    c.beginPath(); c.moveTo(len - R * 0.012, -R * 0.01); c.lineTo(len + 1, 0); c.lineTo(len - R * 0.012, R * 0.01); c.fill();
    c.restore();
    gr = c.createRadialGradient(px - R * 0.01, py - R * 0.01, 1, px, py, R * 0.045);
    gr.addColorStop(0, '#f2f4f5'); gr.addColorStop(1, '#5f666a');
    c.fillStyle = gr; c.beginPath(); c.arc(px, py, R * 0.042, 0, TAU); c.fill();

    // Hub and glass glare.
    c.fillStyle = '#15181a'; c.beginPath(); c.arc(0, 0, R * 0.055, 0, TAU); c.fill();
    gr = c.createRadialGradient(-R * 0.01, -R * 0.01, 1, 0, 0, R * 0.035);
    gr.addColorStop(0, '#f4f5f6'); gr.addColorStop(1, '#6b7175');
    c.fillStyle = gr; c.beginPath(); c.arc(0, 0, R * 0.034, 0, TAU); c.fill();
    c.fillStyle = '#2b2f31'; c.beginPath(); c.arc(0, 0, R * 0.012, 0, TAU); c.fill();
    c.save(); c.beginPath(); c.arc(0, 0, R * 1.03, 0, TAU); c.clip(); c.rotate(0.55);
    gr = c.createLinearGradient(-R * 0.2, 0, R * 0.2, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,.16)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = gr; c.fillRect(R * 0.25, -R * 1.2, R * 0.35, R * 2.4);
    c.restore();
  }

  // ---- scope ----

  #gridScope(_now) {
    const o = this.#o;
    const g = this.#gctx;
    const S = this.#S, dpr = this.#dpr, Rb = S / 2;
    const Rg = this.#g.Rg * Rb, r0 = this.#g.r0 * Rb, fg = this.#g.R * Rb;
    const div = o.divisions;
    const beta = (p) => (TAU * p) / div;
    const pt = (a, r) => [r * Math.sin(a), -r * Math.cos(a)];
    const font = o.fonts.scope;
    g.setTransform(dpr, 0, 0, dpr, (S * dpr) / 2, (S * dpr) / 2);
    g.clearRect(-S, -S, 2 * S, 2 * S);
    const gr = g.createRadialGradient(0, 0, r0, 0, 0, fg);
    gr.addColorStop(0, '#0c1a24'); gr.addColorStop(1, '#05090d');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, fg, 0, TAU); g.fill();
    const C = (a) => `rgba(63,214,232,${a})`;
    for (let k = 0; k <= 50; k++) {
      g.strokeStyle = C(k % 5 === 0 ? 0.26 : 0.07); g.lineWidth = k % 5 === 0 ? 0.8 : 0.5;
      g.beginPath(); g.arc(0, 0, r0 + (k / 50) * (Rg - r0), 0, TAU); g.stroke();
    }
    const sub = div <= 24 ? 4 : 2, majorEvery = div <= 24 ? sub : 10;
    for (let m = 0; m < div * sub; m++) {
      const a = beta(m / sub), maj = m % majorEvery === 0, mid = m % 2 === 0;
      g.strokeStyle = C(maj ? 0.3 : mid ? 0.13 : 0.06); g.lineWidth = maj ? 0.9 : 0.5;
      const [x1, y1] = pt(a, r0), [x2, y2] = pt(a, Rg);
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    g.strokeStyle = C(0.55); g.lineWidth = 1.2; g.beginPath(); g.arc(0, 0, Rg, 0, TAU); g.stroke();
    g.strokeStyle = C(0.4); g.lineWidth = 1; g.beginPath(); g.arc(0, 0, r0, 0, TAU); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const step = div >= 60 ? 5 : 1, quarter = div / 4, rl = (Rg + fg) / 2;
    for (let p = 0; p < div; p += step) {
      const major = p % quarter === 0;
      g.save(); g.rotate(beta(p));
      g.font = `${major ? 700 : 500} ${Math.round(Rb * (major ? 0.042 : 0.033))}px ${font}`;
      g.fillStyle = major ? '#9fe9f3' : '#5d8090';
      g.fillText(String(p).padStart(2, '0'), 0, -rl);
      g.restore();
    }
    g.font = `500 ${Math.round(Rb * 0.026)}px ${font}`;
    for (const q of [0, 0.25, 0.5, 0.75]) {
      for (let i = 1; i <= 10; i++) {
        const v = o.min + ((o.max - o.min) * i) / 10, r = this.#vToR(v) * Rb, a = beta(q * div) + 0.035;
        const [x, y] = pt(a, r);
        g.save(); g.translate(x, y); g.rotate(a);
        g.fillStyle = '#5d8090'; g.fillText(o.formatTick(v), 0, 0);
        g.restore();
      }
    }
  }

  #frameScope(now, live) {
    const o = this.#o;
    const c = this.#ctx;
    const S = this.#S, dpr = this.#dpr, Rb = S / 2;
    const Rg = this.#g.Rg * Rb, r0 = this.#g.r0 * Rb;
    const pt = (a, r) => [r * Math.sin(a), -r * Math.cos(a)];
    const font = o.fonts.scope;
    c.setTransform(dpr, 0, 0, dpr, (this.#W * dpr) / 2, (this.#H * dpr) / 2);
    c.clearRect(-this.#W, -this.#H, 2 * this.#W, 2 * this.#H);
    c.strokeStyle = 'rgba(63,214,232,.25)'; c.lineWidth = 1;
    c.beginPath(); c.arc(0, 0, Rb * 0.985, 0, TAU); c.stroke();
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * TAU, long = i % 10 === 0;
      const [x1, y1] = pt(a, Rb * 0.985), [x2, y2] = pt(a, Rb * (long ? 0.965 : 0.975));
      c.strokeStyle = `rgba(63,214,232,${long ? 0.5 : 0.2})`;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    }
    const beta = TAU * this.#phase(now);
    const rho = o.motion === 'sweep' ? 0 : -beta, head = beta + rho;
    c.save(); c.rotate(rho);
    c.drawImage(this.#grid, -S / 2, -S / 2, S, S);
    if (o.alertAt != null) {
      c.setLineDash([4, 5]); c.strokeStyle = 'rgba(255,90,79,.55)'; c.lineWidth = 1;
      c.beginPath(); c.arc(0, 0, this.#vToR(o.alertAt) * Rb, 0, TAU); c.stroke(); c.setLineDash([]);
    }
    this.#drawTrace(c, now, Rb, true);
    c.restore();

    if (c.createConicGradient) {
      const W = 0.5, gr = c.createConicGradient(head - Math.PI / 2 - W, 0, 0);
      gr.addColorStop(0, 'rgba(63,214,232,0)');
      gr.addColorStop(W / TAU, 'rgba(63,214,232,.16)');
      gr.addColorStop(W / TAU + 0.0005, 'rgba(63,214,232,0)');
      gr.addColorStop(1, 'rgba(63,214,232,0)');
      c.fillStyle = gr; c.beginPath(); c.arc(0, 0, Rg, 0, TAU); c.arc(0, 0, r0, 0, TAU, true); c.fill('evenodd');
    }
    const [hx1, hy1] = pt(head, r0), [hx2, hy2] = pt(head, Rg);
    c.strokeStyle = 'rgba(63,214,232,.7)'; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(hx1, hy1); c.lineTo(hx2, hy2); c.stroke();

    const f = live == null ? 0 : this.#frac(live);
    const rv = this.#vToR(live ?? o.min) * Rb, [px, py] = pt(head, rv);
    const gr = c.createRadialGradient(px, py, 0, px, py, Rb * 0.05);
    gr.addColorStop(0, this.#valueColor(f, 0.9)); gr.addColorStop(1, this.#valueColor(f, 0));
    c.fillStyle = gr; c.beginPath(); c.arc(px, py, Rb * 0.05, 0, TAU); c.fill();
    c.fillStyle = '#ffffff'; c.beginPath(); c.arc(px, py, Math.max(2, Rb * 0.009), 0, TAU); c.fill();
    c.strokeStyle = this.#valueColor(f, 0.9); c.lineWidth = 1.2;
    c.beginPath(); c.arc(0, 0, rv, head - Math.PI / 2 - 0.06, head - Math.PI / 2 + 0.06); c.stroke();

    c.fillStyle = '#060c11'; c.beginPath(); c.arc(0, 0, r0 * 0.94, 0, TAU); c.fill();
    c.strokeStyle = this.#valueColor(f, 0.55); c.lineWidth = 1.5;
    c.beginPath(); c.arc(0, 0, r0 * 0.94, 0, TAU); c.stroke();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = this.#valueColor(f, 1);
    c.font = `700 ${Math.round(r0 * 0.34)}px ${font}`;
    c.fillText(live == null ? '—' : (o.formatValue ?? o.formatTick)(live), 0, -r0 * 0.08);
    c.fillStyle = '#6c8594';
    c.font = `500 ${Math.round(r0 * 0.14)}px ${font}`;
    c.fillText(o.unit, 0, r0 * 0.3);
    c.font = `500 ${Math.round(r0 * 0.1)}px ${font}`;
    c.fillText(this.#fmtTime(now), 0, r0 * 0.52);
  }
}

if (!customElements.get('chart-recorder')) customElements.define('chart-recorder', ChartRecorder);
