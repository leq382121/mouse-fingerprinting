import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFingerprint, fingerprintWindows, segment, FEATURE_NAMES, MOUSE_FEATURE_NAMES } from '../src/features.js';
import { ProfileStore, DEFAULT_THRESHOLD } from '../src/matcher.js';
import { makeUser, makeSession } from './simulate.js';

const USERS = 15;

test('segmentation finds one stroke and one click per target', () => {
  const events = makeSession(makeUser(1), 2, { targets: 30 });
  const { strokes, clicks } = segment(events);
  assert.equal(clicks.length, 30);
  assert.ok(strokes.length >= 30 && strokes.length <= 60, `strokes=${strokes.length}`);
});

test('fingerprint has a finite value for every mouse feature', () => {
  const fp = extractFingerprint(makeSession(makeUser(1), 2));
  assert.equal(fp.vector.length, FEATURE_NAMES.length);
  const missing = MOUSE_FEATURE_NAMES.filter((name) => !Number.isFinite(fp.features[name]));
  assert.deepEqual(missing, []);
  assert.equal(fp.quality, 'good');
});

test('identifies simulated users from a new session', () => {
  const store = new ProfileStore();
  const users = Array.from({ length: USERS }, (_, i) => makeUser(100 + i));
  users.forEach((u, i) => {
    for (const w of fingerprintWindows(makeSession(u, 1000 + i), { strokesPerWindow: 25 })) {
      store.enroll(`user${i}`, w);
    }
  });

  let correct = 0;
  let total = 0;
  const genuine = [];
  const impostor = [];
  users.forEach((u, i) => {
    for (const w of fingerprintWindows(makeSession(u, 2000 + i), { strokesPerWindow: 25 })) {
      const res = store.identify(w);
      total++;
      if (res.ranking[0].id === `user${i}`) correct++;
      for (const r of res.ranking) (r.id === `user${i}` ? genuine : impostor).push(r.distance);
    }
  });

  const accuracy = correct / total;
  const far = impostor.filter((d) => d <= DEFAULT_THRESHOLD).length / impostor.length;
  const frr = genuine.filter((d) => d > DEFAULT_THRESHOLD).length / genuine.length;
  console.log(
    `  ${USERS} users, ${total} probes: top-1 accuracy ${(accuracy * 100).toFixed(1)}%, ` +
      `at threshold ${DEFAULT_THRESHOLD}: FAR ${(far * 100).toFixed(1)}%, FRR ${(frr * 100).toFixed(1)}%`,
  );
  assert.ok(accuracy >= 0.85, `accuracy ${accuracy}`);
});

test('profiles survive a JSON round trip', () => {
  const store = new ProfileStore();
  const fp = extractFingerprint(makeSession(makeUser(5), 6));
  store.enroll('a', fp);
  store.enroll('b', extractFingerprint(makeSession(makeUser(7), 8)));
  const restored = ProfileStore.fromJSON(JSON.parse(JSON.stringify(store)));
  assert.equal(restored.identify(fp).ranking[0].id, 'a');
});
