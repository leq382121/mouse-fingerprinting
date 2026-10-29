// Turns a raw event log (see collector.js) into a fixed-length feature vector
// describing *how* someone moves the mouse, not *where*, plus their interface
// habits (interaction.js). Only behaviour goes in: nothing about the browser,
// device or screen. Runs in the browser and in Node.

import { medIqr, median, linreg } from './stats.js';
import { interactionFeatures, INTERACTION_FEATURE_NAMES } from './interaction.js';

// A gap between move events longer than this ends a stroke.
export const PAUSE_MS = 250;
const MIN_POINTS = 4;
const MIN_DIST = 20; // px; shorter strokes are mostly hand tremor
const DRAG_PX = 5; // movement while a button is held that makes it a drag

// Per-stroke measurements. `log` ones are heavy-tailed and get log-transformed
// before aggregation so medians/IQRs behave.
const STROKE_KEYS = [
  { key: 'duration', log: true },
  { key: 'meanSpeed', log: true },
  { key: 'peakSpeed', log: true },
  { key: 'speedCV', log: false },
  { key: 'straightness', log: false },
  { key: 'curvature', log: true },
  { key: 'peakAcc', log: true },
  { key: 'peakDec', log: true },
  { key: 'meanAbsJerk', log: true },
  { key: 'tPeak', log: false },
  { key: 'submovements', log: false },
  { key: 'overshoot', log: false },
  { key: 'maxDev', log: false },
];

export const MOUSE_FEATURE_NAMES = [
  ...STROKE_KEYS.flatMap(({ key }) => [`${key}_med`, `${key}_iqr`]),
  // Fitts-style fit: duration = a + b * log2(1 + distance)
  'fitts_a',
  'fitts_b',
  // How peak speed scales with distance: log(peakSpeed) = c + k * log(distance)
  'speedScale_k',
  'click_hold_med',
  'click_hold_iqr',
  'click_dwell_med',
  'click_dwell_iqr',
];

export const FEATURE_NAMES = [...MOUSE_FEATURE_NAMES, ...INTERACTION_FEATURE_NAMES];

// --- helpers -------------------------------------------------------------------

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function smooth(values, radius = 2) {
  return values.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j];
      n++;
    }
    return sum / n;
  });
}

// --- segmentation ------------------------------------------------------------

// Splits the event log into movement strokes and clicks.
export function segment(events) {
  const strokes = [];
  const clicks = [];
  let cur = [];
  let lastMove = null;
  let down = null;

  const flush = (endsInClick) => {
    if (cur.length >= MIN_POINTS) strokes.push({ points: cur, endsInClick, t0: cur[0].t });
    cur = [];
  };

  for (const e of events) {
    if (e.type === 'm') {
      if (lastMove && e.t - lastMove.t > PAUSE_MS) flush(false);
      cur.push(e);
      lastMove = e;
      if (down) down.moved = Math.max(down.moved, Math.hypot(e.x - down.x, e.y - down.y));
    } else if (e.type === 'd') {
      const dwell = lastMove ? e.t - lastMove.t : NaN;
      flush(dwell < 1000);
      down = { t: e.t, x: e.x, y: e.y, b: e.b, dwell, moved: 0 };
    } else if (e.type === 'u') {
      if (down && down.b === e.b && down.moved <= DRAG_PX) {
        clicks.push({ hold: e.t - down.t, dwell: down.dwell });
      }
      down = null;
    }
  }
  flush(false);
  return { strokes, clicks };
}

// --- per-stroke features -----------------------------------------------------

export function strokeFeatures(points) {
  // Collapse samples that share a timestamp, keeping the latest position.
  const p = [];
  for (const q of points) {
    const last = p[p.length - 1];
    if (last && q.t - last.t < 0.5) {
      p[p.length - 1] = { t: last.t, x: q.x, y: q.y };
    } else {
      p.push({ t: q.t, x: q.x, y: q.y });
    }
  }
  const n = p.length;
  if (n < MIN_POINTS) return null;

  const first = p[0];
  const last = p[n - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const dist = Math.hypot(dx, dy);
  const duration = last.t - first.t;
  if (dist < MIN_DIST || duration <= 0) return null;

  let path = 0;
  let turning = 0;
  let prevHeading = null;
  const speeds = [];
  const speedT = [];
  for (let i = 1; i < n; i++) {
    const sx = p[i].x - p[i - 1].x;
    const sy = p[i].y - p[i - 1].y;
    const d = Math.hypot(sx, sy);
    const dt = p[i].t - p[i - 1].t;
    path += d;
    speeds.push(d / dt);
    speedT.push((p[i].t + p[i - 1].t) / 2);
    if (d > 0.5) {
      const heading = Math.atan2(sy, sx);
      if (prevHeading !== null) turning += Math.abs(wrapAngle(heading - prevHeading));
      prevHeading = heading;
    }
  }

  const v = smooth(speeds);
  const acc = [];
  const accT = [];
  for (let i = 1; i < v.length; i++) {
    acc.push((v[i] - v[i - 1]) / (speedT[i] - speedT[i - 1]));
    accT.push((speedT[i] + speedT[i - 1]) / 2);
  }
  const jerk = [];
  for (let i = 1; i < acc.length; i++) {
    jerk.push((acc[i] - acc[i - 1]) / (accT[i] - accT[i - 1]));
  }

  let peakIdx = 0;
  for (let i = 1; i < v.length; i++) if (v[i] > v[peakIdx]) peakIdx = i;
  const peakSpeed = v[peakIdx];

  const meanV = v.reduce((s, x) => s + x, 0) / v.length;
  const sdV = Math.sqrt(v.reduce((s, x) => s + (x - meanV) ** 2, 0) / v.length);

  // Submovements: speed peaks above 50% of max separated by a dip below 25%.
  let submovements = 0;
  let armed = true;
  for (const s of v) {
    if (armed && s > 0.5 * peakSpeed) {
      submovements++;
      armed = false;
    } else if (!armed && s < 0.25 * peakSpeed) {
      armed = true;
    }
  }

  // Overshoot past the end point along the movement axis, and max sideways
  // deviation from the straight line, both relative to distance.
  const ux = dx / dist;
  const uy = dy / dist;
  let maxProj = 0;
  let maxDev = 0;
  for (const q of p) {
    const rx = q.x - first.x;
    const ry = q.y - first.y;
    maxProj = Math.max(maxProj, rx * ux + ry * uy);
    maxDev = Math.max(maxDev, Math.abs(rx * uy - ry * ux));
  }

  return {
    dist,
    duration,
    meanSpeed: path / duration,
    peakSpeed,
    speedCV: meanV > 0 ? sdV / meanV : NaN,
    straightness: path > 0 ? dist / path : NaN,
    curvature: turning / path + 1e-4,
    peakAcc: Math.max(1e-6, ...acc),
    peakDec: Math.max(1e-6, ...acc.map((a) => -a)),
    meanAbsJerk: jerk.length ? jerk.reduce((s, j) => s + Math.abs(j), 0) / jerk.length + 1e-9 : NaN,
    tPeak: (speedT[peakIdx] - first.t) / duration,
    submovements,
    overshoot: Math.max(0, maxProj - dist) / dist,
    maxDev: maxDev / dist,
  };
}

// --- session fingerprint -----------------------------------------------------

export function extractFingerprint(events) {
  const { strokes, clicks } = segment(events);
  const sf = [];
  for (const s of strokes) {
    const f = strokeFeatures(s.points);
    if (f) sf.push({ ...f, endsInClick: s.endsInClick });
  }

  const features = {};
  for (const { key, log } of STROKE_KEYS) {
    const vals = sf.map((f) => (log ? Math.log(f[key]) : f[key]));
    const { med, iqr } = medIqr(vals);
    features[`${key}_med`] = med;
    features[`${key}_iqr`] = iqr;
  }

  // Aimed movements (ending in a click) follow Fitts' law most closely; fall
  // back to all strokes if there are too few of them.
  const aimed = sf.filter((f) => f.endsInClick).length >= 8 ? sf.filter((f) => f.endsInClick) : sf;
  const fitts = linreg(aimed.map((f) => Math.log2(1 + f.dist)), aimed.map((f) => f.duration));
  features.fitts_a = fitts.a;
  features.fitts_b = fitts.b;
  features.speedScale_k = linreg(sf.map((f) => Math.log(f.dist)), sf.map((f) => Math.log(f.peakSpeed))).b;

  const hold = medIqr(clicks.map((c) => Math.log(Math.max(1, c.hold))));
  features.click_hold_med = hold.med;
  features.click_hold_iqr = hold.iqr;
  const dwell = medIqr(clicks.filter((c) => c.dwell < 2000).map((c) => Math.log(Math.max(1, c.dwell))));
  features.click_dwell_med = dwell.med;
  features.click_dwell_iqr = dwell.iqr;

  const interaction = interactionFeatures(events);
  Object.assign(features, interaction.features);

  const clickHolds = clicks.map((c) => c.hold);
  return {
    vector: FEATURE_NAMES.map((name) => (Number.isFinite(features[name]) ? features[name] : NaN)),
    features,
    strokeCount: sf.length,
    clickCount: clicks.length,
    interaction: interaction.counts,
    quality: sf.length >= 40 ? 'good' : sf.length >= 15 ? 'ok' : 'low',
    // Human-readable numbers in real units, for display/debugging.
    summary: {
      medianPeakSpeedPxPerMs: median(sf.map((f) => f.peakSpeed)),
      medianStraightness: median(sf.map((f) => f.straightness)),
      medianClickHoldMs: median(clickHolds),
      medianOvershootPct: median(sf.map((f) => f.overshoot)) * 100,
    },
  };
}

// Cuts a long event log into chunks of roughly `strokesPerWindow` strokes and
// fingerprints each one. Useful for enrolling several samples from one session.
export function fingerprintWindows(events, { strokesPerWindow = 20 } = {}) {
  const { strokes } = segment(events);
  const cuts = [];
  for (let i = strokesPerWindow; i + strokesPerWindow <= strokes.length; i += strokesPerWindow) {
    cuts.push(strokes[i].t0);
  }
  const windows = [];
  let start = 0;
  for (const cut of [...cuts, Infinity]) {
    let end = start;
    while (end < events.length && events[end].t < cut) end++;
    windows.push(extractFingerprint(events.slice(start, end)));
    start = end;
  }
  return windows.filter((w) => w.quality !== 'low');
}
