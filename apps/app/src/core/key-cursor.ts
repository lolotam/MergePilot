/** Writes `position` into `0 .. length - 1`. An empty list has no valid index. */
export function clampKeyCursor(position: number, length: number): number {
  if (length <= 0) return 0;
  const index = Math.trunc(position);
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(index, length - 1);
}
