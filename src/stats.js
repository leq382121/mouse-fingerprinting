// Small robust-statistics helpers shared by the feature extractors.

export function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function medIqr(values) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { med: quantile(s, 0.5), iqr: quantile(s, 0.75) - quantile(s, 0.25) };
}

export function median(values) {
  return medIqr(values).med;
}

export function linreg(xs, ys) {
  const n = xs.length;
  if (n < 5) return { a: NaN, b: NaN };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const varX = sxx - (sx * sx) / n;
  if (varX <= 1e-9) return { a: NaN, b: NaN };
  const b = (sxy - (sx * sy) / n) / varX;
  return { a: (sy - b * sx) / n, b };
}

// Share of `k` out of `n`, smoothed so that 0/1 and 1/1 are not treated as
// certainties. NaN when there were no observations at all.
export function share(k, n) {
  return n > 0 ? (k + 0.5) / (n + 1) : NaN;
}
