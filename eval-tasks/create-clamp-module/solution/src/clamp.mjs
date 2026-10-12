export function clamp(value, min, max) {
  if (min > max) throw new Error("min must not be greater than max");
  return Math.min(Math.max(value, min), max);
}
