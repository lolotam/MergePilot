// Temporary file for a live test of the MergePilot GitHub App with GLM. Do not merge.
import { execSync } from 'node:child_process';

export function average(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export function parsePort(raw: string): number {
  return parseInt(raw);
}

export function findUserQuery(name: string): string {
  return `SELECT * FROM users WHERE name = '${name}'`;
}

export function listFiles(dir: string): string {
  return execSync(`ls ${dir}`).toString();
}
