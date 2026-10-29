// Enrolment and matching of mouse fingerprints.
//
// Each profile keeps the raw feature vectors it was enrolled with. A model is
// a per-feature mean and spread; distance is the scaled Manhattan distance
// (mean |x - mu| / sigma over the features both sides have), which is a
// well-known strong baseline for keystroke and mouse dynamics.

import { FEATURE_NAMES } from './features.js';

// Pseudo-samples of population variance blended into each profile's own
// variance, so profiles with 1-2 samples do not get absurdly tight bounds.
const SHRINK = 3;
const MIN_FEATURES = 8;
// Raw Fisher ratios are dominated by device features (polling rate) that
// barely vary per person but are shared by many people, so they are
// square-rooted and capped relative to the mean weight.
const WEIGHT_POWER = 0.5;
const WEIGHT_CAP = 3;

// Calibrated on synthetic data (see bench/); retune on real traffic.
export const DEFAULT_THRESHOLD = 0.85;

function meanVar(values) {
  const v = values.filter(Number.isFinite);
  if (v.length === 0) return { mean: NaN, variance: NaN, n: 0 };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length;
  return { mean, variance, n: v.length };
}

const toVector = (fp) => Array.from(fp.vector ?? fp);

// Accepts one fingerprint or an array of them (e.g. consecutive windows from
// one visit) and returns a list of vectors.
const toProbes = (fp) =>
  Array.isArray(fp) && typeof fp[0] !== 'number' ? fp.map(toVector) : [toVector(fp)];

export class ProfileStore {
  constructor(json, { weighting = 'fisher' } = {}) {
    this.profiles = new Map(Object.entries(json?.profiles ?? {}));
    this.options = { weighting };
    this._cache = null;
  }

  enroll(id, fingerprint) {
    const vec = toVector(fingerprint);
    if (vec.length !== FEATURE_NAMES.length) throw new Error('feature vector length mismatch');
    if (!this.profiles.has(id)) this.profiles.set(id, { samples: [] });
    this.profiles.get(id).samples.push(vec);
    this._cache = null;
  }

  remove(id) {
    this.profiles.delete(id);
    this._cache = null;
  }

  ids() {
    return [...this.profiles.keys()];
  }

  // Builds every profile model plus per-feature weights once, and reuses them
  // until the next enroll/remove.
  _models() {
    if (this._cache) return this._cache;
    const all = [...this.profiles.values()].flatMap((p) => p.samples);
    const popVar = FEATURE_NAMES.map((_, j) => meanVar(all.map((s) => s[j])).variance);
    const models = new Map();
    for (const [id, { samples }] of this.profiles) {
      models.set(id, FEATURE_NAMES.map((_, j) => {
        const { mean, variance, n } = meanVar(samples.map((s) => s[j]));
        const pv = Number.isFinite(popVar[j]) ? popVar[j] : variance;
        const blended = (n * variance + SHRINK * pv) / (n + SHRINK);
        return { mu: mean, sigma: Math.sqrt(blended) + 1e-6 + 0.05 * Math.sqrt(pv || 0) };
      }));
    }
    this._cache = { models, weights: this._weights() };
    return this._cache;
  }

  // Fisher ratio per feature: how much profiles differ from each other
  // relative to how much one profile varies across its own samples. Features
  // that are mostly noise (or mostly page layout) get pushed towards zero.
  // Needs at least two profiles with two samples; otherwise all weights are 1.
  _weights() {
    const uniform = FEATURE_NAMES.map(() => 1);
    if (this.options.weighting !== 'fisher') return uniform;
    const profiles = [...this.profiles.values()].filter((p) => p.samples.length >= 2);
    if (profiles.length < 2) return uniform;
    const raw = FEATURE_NAMES.map((_, j) => {
      const stats = profiles.map((p) => meanVar(p.samples.map((s) => s[j]))).filter((s) => s.n >= 2);
      if (stats.length < 2) return 0;
      const within = stats.reduce((s, x) => s + x.variance, 0) / stats.length;
      const between = meanVar(stats.map((s) => s.mean)).variance;
      return within > 0 ? between / within : 0;
    });
    const damped = raw.map((w) => w ** WEIGHT_POWER);
    const mean = damped.reduce((s, x) => s + x, 0) / damped.length;
    return mean > 0 ? damped.map((w) => Math.min(WEIGHT_CAP, w / mean)) : uniform;
  }

  static distance(vec, model, weights) {
    let sum = 0;
    let weightSum = 0;
    let used = 0;
    for (let j = 0; j < model.length; j++) {
      const { mu, sigma } = model[j];
      if (!Number.isFinite(vec[j]) || !Number.isFinite(mu) || !Number.isFinite(sigma)) continue;
      const w = weights ? weights[j] : 1;
      sum += (w * Math.abs(vec[j] - mu)) / sigma;
      weightSum += w;
      used++;
    }
    return used >= MIN_FEATURES && weightSum > 0 ? sum / weightSum : Infinity;
  }

  // Combines several probe windows into one distance. Noise in independent
  // windows cancels out, so a decision over a whole visit is far more
  // reliable than one over a single window.
  _probeDistance(probes, model, weights) {
    const d = probes.map((v) => ProfileStore.distance(v, model, weights)).filter(Number.isFinite);
    return d.length ? d.reduce((s, x) => s + x, 0) / d.length : Infinity;
  }

  // Ranks every enrolled profile against the fingerprint(s). `best` is null
  // when even the closest profile is further away than the threshold.
  identify(fingerprint, { threshold = DEFAULT_THRESHOLD } = {}) {
    const probes = toProbes(fingerprint);
    const { models, weights } = this._models();
    const ranking = [...models]
      .map(([id, model]) => ({ id, distance: this._probeDistance(probes, model, weights) }))
      .sort((a, b) => a.distance - b.distance);
    const top = ranking[0];
    const matched = top && top.distance <= threshold;
    return { best: matched ? top.id : null, distance: top?.distance ?? Infinity, ranking };
  }

  // 1:1 check: does this fingerprint look like the claimed profile?
  verify(id, fingerprint, { threshold = DEFAULT_THRESHOLD } = {}) {
    if (!this.profiles.has(id)) return { match: false, distance: Infinity };
    const { models, weights } = this._models();
    const distance = this._probeDistance(toProbes(fingerprint), models.get(id), weights);
    return { match: distance <= threshold, distance };
  }

  toJSON() {
    // JSON has no NaN, so missing features are stored as null and restored below.
    return { profiles: Object.fromEntries(this.profiles) };
  }

  static fromJSON(json, options) {
    const store = new ProfileStore(json, options);
    for (const [id, p] of store.profiles) {
      // Samples saved with a different feature set cannot be compared.
      p.samples = p.samples
        .filter((s) => s.length === FEATURE_NAMES.length)
        .map((s) => s.map((x) => (x === null ? NaN : x)));
      if (p.samples.length === 0) store.profiles.delete(id);
    }
    return store;
  }
}
