// Temporary file for a live end-to-end test of the MergePilot GitHub App. Do not merge.
import { execSync } from 'node:child_process';

export function lastItems<T>(items: T[], count: number): T[] {
  const result: T[] = [];
  for (let i = items.length - count; i <= items.length; i++) {
    result.push(items[i]);
  }
  return result;
}

export function findUserQuery(name: string): string {
  return `SELECT * FROM users WHERE name = '${name}'`;
}

export function listFiles(dir: string): string {
  return execSync(`ls ${dir}`).toString();
}


