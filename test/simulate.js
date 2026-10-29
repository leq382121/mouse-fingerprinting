// Generates synthetic mouse sessions for distinct simulated users, so the
// pipeline can be tested without real recordings. Each user has stable motor
// habits (speed, curvature, overshoot, click timing, device); each session
// adds a little day-to-day variation on top.

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

const between = (r, lo, hi) => lo + (hi - lo) * r();

export function makeUser(seed) {
  const r = rng(seed);
  return {
    fittsA: between(r, 80, 250), // ms
    fittsB: between(r, 70, 190), // ms per bit
    asymmetry: between(r, 0.7, 1.4), // time warp exponent -> where the speed peak sits
    bow: between(r, -0.12, 0.12), // sideways arc as a fraction of distance
    jitter: between(r, 0.2, 1.8), // px of hand noise
    overshootProb: between(r, 0, 0.6),
    overshootSize: between(r, 0.02, 0.12),
    holdMs: between(r, 55, 150),
    holdSd: between(r, 8, 30),
    dwellMs: between(r, 60, 400),
    pollMs: [4, 8, 8, 16][Math.floor(r() * 4)],
  };
}

function minJerk(tau) {
  return 10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5;
}

// Moves from `from` to `to`, appending 'm' events. Returns the end time.
function move(events, r, u, from, to, t0, durationScale = 1) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = Math.max(40, (u.fittsA + u.fittsB * Math.log2(1 + dist / 20)) * durationScale * (1 + 0.12 * gauss(r)));
  const nx = -(to.y - from.y) / (dist || 1);
  const ny = (to.x - from.x) / (dist || 1);
  const bow = u.bow * (1 + 0.3 * gauss(r));
  for (let t = 0; t <= duration; t += u.pollMs * (1 + 0.05 * gauss(r))) {
    const s = minJerk(Math.pow(t / duration, u.asymmetry));
    const side = bow * dist * Math.sin(Math.PI * s);
    events.push({
      type: 'm',
      t: t0 + t,
      x: from.x + (to.x - from.x) * s + nx * side + u.jitter * gauss(r),
      y: from.y + (to.y - from.y) * s + ny * side + u.jitter * gauss(r),
    });
  }
  return t0 + duration;
}

export function makeSession(user, seed, { targets = 100, drift = 0.06 } = {}) {
  const r = rng(seed);
  // Day-to-day variation: same person, slightly different mood/posture.
  const u = { ...user };
  for (const k of ['fittsA', 'fittsB', 'jitter', 'holdMs', 'dwellMs', 'bow', 'overshootProb', 'asymmetry']) {
    u[k] *= 1 + drift * gauss(r);
  }

  const events = [];
  let t = 1000;
  let pos = { x: 800, y: 450 };
  for (let i = 0; i < targets; i++) {
    const target = { x: between(r, 40, 1560), y: between(r, 40, 860) };
    const dist = Math.hypot(target.x - pos.x, target.y - pos.y);
    if (r() < u.overshootProb) {
      const k = 1 + u.overshootSize * (1 + 0.4 * gauss(r));
      const past = { x: pos.x + (target.x - pos.x) * k, y: pos.y + (target.y - pos.y) * k };
      t = move(events, r, u, pos, past, t);
      t = move(events, r, u, past, target, t + u.pollMs, 0.6);
    } else {
      t = move(events, r, u, pos, target, t);
    }
    pos = target;

    t += Math.max(10, u.dwellMs * (1 + 0.3 * gauss(r)));
    events.push({ type: 'd', t, x: pos.x, y: pos.y, b: 0 });
    t += Math.max(20, u.holdMs + u.holdSd * gauss(r));
    events.push({ type: 'u', t, x: pos.x, y: pos.y, b: 0 });

    t += between(r, 300, 900); // reading/thinking pause between targets
  }
  return events;
}
