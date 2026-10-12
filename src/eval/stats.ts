// 95% Wilson score interval for a pass rate of k successes in n trials.
// Preferred over the plain normal approximation because eval sample sizes
// are tiny (often 3 to 30 runs) and pass rates sit near 0% or 100%, where the
// normal interval is badly wrong (it can exceed [0, 1] or collapse to zero
// width).
export function wilsonInterval(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

export function intervalsOverlap(a: { low: number; high: number }, b: { low: number; high: number }): boolean {
  return a.low <= b.high && b.low <= a.high;
}
