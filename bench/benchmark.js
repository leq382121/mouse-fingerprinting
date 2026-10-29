// Accuracy benchmark on simulated users. Enrolls each user from one session and
// probes with windows from a different session.
//
//   node bench/benchmark.js
//
// Reports top-1 identification accuracy, verification EER, and FAR/FRR at the
// default threshold. "multi" probes combine 3 consecutive windows, as a site
// would by accumulating evidence over a visit.

import { fingerprintWindows } from '../src/features.js';
import { ProfileStore, DEFAULT_THRESHOLD } from '../src/matcher.js';
import { makeUser, makeSession } from '../test/simulate.js';

export const SCENARIOS = {
  easy: { users: 15, strokesPerWindow: 25, drift: 0.06, enrollTargets: 100, probeTargets: 100 },
  hard: { users: 50, strokesPerWindow: 15, drift: 0.15, enrollTargets: 100, probeTargets: 120 },
};

function eer(genuine, impostor) {
  const thresholds = [...genuine, ...impostor].filter(Number.isFinite).sort((a, b) => a - b);
  let best = { gap: Infinity, rate: 1, threshold: NaN };
  for (const th of thresholds) {
    const far = impostor.filter((d) => d <= th).length / impostor.length;
    const frr = genuine.filter((d) => d > th).length / genuine.length;
    if (Math.abs(far - frr) < best.gap) best = { gap: Math.abs(far - frr), rate: (far + frr) / 2, threshold: th };
  }
  return best;
}

export function runScenario(cfg, { seed = 0, group = 1, storeOptions } = {}) {
  const store = new ProfileStore(undefined, storeOptions);
  const users = Array.from({ length: cfg.users }, (_, i) => makeUser(seed * 1000 + 100 + i));
  users.forEach((u, i) => {
    const events = makeSession(u, seed * 1000 + 5000 + i, { targets: cfg.enrollTargets, drift: cfg.drift });
    for (const w of fingerprintWindows(events, { strokesPerWindow: cfg.strokesPerWindow })) store.enroll(`u${i}`, w);
  });

  let correct = 0;
  let total = 0;
  const genuine = [];
  const impostor = [];
  users.forEach((u, i) => {
    const events = makeSession(u, seed * 1000 + 9000 + i, { targets: cfg.probeTargets, drift: cfg.drift });
    const windows = fingerprintWindows(events, { strokesPerWindow: cfg.strokesPerWindow });
    for (let k = 0; k + group <= windows.length; k += group) {
      const probe = group === 1 ? windows[k] : windows.slice(k, k + group);
      const { ranking } = store.identify(probe);
      total++;
      if (ranking[0].id === `u${i}`) correct++;
      for (const r of ranking) (r.id === `u${i}` ? genuine : impostor).push(r.distance);
    }
  });

  const e = eer(genuine, impostor);
  return {
    top1: correct / total,
    eer: e.rate,
    eerThreshold: e.threshold,
    far: impostor.filter((d) => d <= DEFAULT_THRESHOLD).length / impostor.length,
    frr: genuine.filter((d) => d > DEFAULT_THRESHOLD).length / genuine.length,
  };
}

function average(results) {
  const keys = Object.keys(results[0]);
  return Object.fromEntries(keys.map((k) => [k, results.reduce((s, r) => s + r[k], 0) / results.length]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(6);
  console.log('scenario  probe   top-1    EER  (EER th)  FAR@th   FRR@th');
  for (const [name, cfg] of Object.entries(SCENARIOS)) {
    for (const group of [1, 3]) {
      const r = average([0, 1, 2].map((seed) => runScenario(cfg, { seed, group })));
      console.log(
        `${name.padEnd(8)}  ${(group === 1 ? 'single' : 'multi').padEnd(6)} ${pct(r.top1)} ${pct(r.eer)}   ${r.eerThreshold.toFixed(2)}` +
          `     ${pct(r.far)}  ${pct(r.frr)}`,
      );
    }
  }
}
