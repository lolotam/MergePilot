// Temporary file for a live test of the MergePilot GitHub App with a new provider key. Do not merge.
export function average(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export function parsePort(raw: string): number {
  return parseInt(raw);
}
