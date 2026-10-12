import type { RepoColorKey } from '@mergepilot/app/contract';

/** Tailwind classes of one palette color. Full class names, so Tailwind's scanner keeps them. */
export interface RepoColor {
  key: RepoColorKey;
  /** 4px strip on the row's leading edge (border-inline-start: right in RTL, left in LTR). */
  strip: string;
  /** Very light row background. */
  tint: string;
  /** Repo chip: background + text (AA contrast in light and dark). */
  chip: string;
  /** Dot in the chip and the picker swatch. */
  dot: string;
}

/** The fixed palette (same keys as the server's REPO_COLOR_KEYS; order matters for the hash). */
export const REPO_PALETTE: readonly RepoColor[] = [
  { key: 'sky', strip: 'border-s-4 border-s-sky-500 dark:border-s-sky-400', tint: 'bg-sky-50/70 dark:bg-sky-950/25', chip: 'bg-sky-100 text-sky-900 dark:bg-sky-900/60 dark:text-sky-100', dot: 'bg-sky-500' },
  { key: 'teal', strip: 'border-s-4 border-s-teal-500 dark:border-s-teal-400', tint: 'bg-teal-50/70 dark:bg-teal-950/25', chip: 'bg-teal-100 text-teal-900 dark:bg-teal-900/60 dark:text-teal-100', dot: 'bg-teal-500' },
  { key: 'emerald', strip: 'border-s-4 border-s-emerald-500 dark:border-s-emerald-400', tint: 'bg-emerald-50/70 dark:bg-emerald-950/25', chip: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-100', dot: 'bg-emerald-500' },
  { key: 'lime', strip: 'border-s-4 border-s-lime-500 dark:border-s-lime-400', tint: 'bg-lime-50/70 dark:bg-lime-950/25', chip: 'bg-lime-100 text-lime-900 dark:bg-lime-900/60 dark:text-lime-100', dot: 'bg-lime-500' },
  { key: 'amber', strip: 'border-s-4 border-s-amber-500 dark:border-s-amber-400', tint: 'bg-amber-50/70 dark:bg-amber-950/25', chip: 'bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100', dot: 'bg-amber-500' },
  { key: 'orange', strip: 'border-s-4 border-s-orange-500 dark:border-s-orange-400', tint: 'bg-orange-50/70 dark:bg-orange-950/25', chip: 'bg-orange-100 text-orange-900 dark:bg-orange-900/60 dark:text-orange-100', dot: 'bg-orange-500' },
  { key: 'rose', strip: 'border-s-4 border-s-rose-500 dark:border-s-rose-400', tint: 'bg-rose-50/70 dark:bg-rose-950/25', chip: 'bg-rose-100 text-rose-900 dark:bg-rose-900/60 dark:text-rose-100', dot: 'bg-rose-500' },
  { key: 'fuchsia', strip: 'border-s-4 border-s-fuchsia-500 dark:border-s-fuchsia-400', tint: 'bg-fuchsia-50/70 dark:bg-fuchsia-950/25', chip: 'bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-900/60 dark:text-fuchsia-100', dot: 'bg-fuchsia-500' },
  { key: 'violet', strip: 'border-s-4 border-s-violet-500 dark:border-s-violet-400', tint: 'bg-violet-50/70 dark:bg-violet-950/25', chip: 'bg-violet-100 text-violet-900 dark:bg-violet-900/60 dark:text-violet-100', dot: 'bg-violet-500' },
  { key: 'indigo', strip: 'border-s-4 border-s-indigo-500 dark:border-s-indigo-400', tint: 'bg-indigo-50/70 dark:bg-indigo-950/25', chip: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-900/60 dark:text-indigo-100', dot: 'bg-indigo-500' },
];

const BY_KEY = new Map<string, RepoColor>(REPO_PALETTE.map((c) => [c.key, c]));

/** 32-bit FNV-1a of the lowercased `owner/repo`: stable across pages, reloads and browsers. */
export function hashRepo(repoFullName: string): number {
  let hash = 0x811c9dc5;
  for (const ch of repoFullName.toLowerCase()) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export type RepoColorOverrides = Partial<Record<string, RepoColorKey>>;

/** The workspace's chosen color for the repo, else the hashed default. */
export function repoColor(repoFullName: string, overrides?: RepoColorOverrides): RepoColor {
  const chosen = overrides?.[repoFullName];
  const picked = chosen ? BY_KEY.get(chosen) : undefined;
  return picked ?? REPO_PALETTE[hashRepo(repoFullName) % REPO_PALETTE.length]!;
}

/** i18n key of a palette color's name (for the picker's labels). */
export function colorLabelKey(key: RepoColorKey) {
  return `color${key.charAt(0).toUpperCase()}${key.slice(1)}` as
    | 'colorSky'
    | 'colorTeal'
    | 'colorEmerald'
    | 'colorLime'
    | 'colorAmber'
    | 'colorOrange'
    | 'colorRose'
    | 'colorFuchsia'
    | 'colorViolet'
    | 'colorIndigo';
}
