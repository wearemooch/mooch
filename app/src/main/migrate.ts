// One-time carry-over into ~/.mooch from where earlier versions kept the user's data (the app-data
// folder, named "mooch" or, before the rename, "free-code"), so provider keys and settings survive.
// Only runs when ~/.mooch doesn't exist yet; the old folders are left as they were.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Files worth keeping, old location → new location: user settings and the gateway's config (keys, models, proxy token). */
const CARRIED: [string, string][] = [
  ['settings.json', 'settings.json'],
  [path.join('fcc-home', '.fcc', '.env'), path.join('gateway', '.fcc', '.env')],
];

/**
 * Copies from the first of `previousDirs` that holds any of the files (newest location first).
 * Returns the files copied, relative to the new folder.
 */
export function carryOverData(previousDirs: string[], home: string): string[] {
  if (existsSync(home)) return [];
  for (const previousDir of previousDirs) {
    const copied: string[] = [];
    for (const [from, to] of CARRIED) {
      const source = path.join(previousDir, from);
      if (!existsSync(source)) continue;
      const target = path.join(home, to);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
      copied.push(to);
    }
    if (copied.length) return copied;
  }
  return [];
}
