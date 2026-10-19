// Containment that follows links. A string check alone ("is this path under the project folder?")
// is fooled by a symlink or junction inside the project that points elsewhere, so these resolve
// where a path really lands before comparing.
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Where `target` really is: links in the part of the path that exists are followed, and the part that
 * doesn't exist yet is appended. Undefined when that can't be known safely, such as a dangling link
 * on the way (writing through it would create its target, wherever that is).
 */
export function realTarget(target: string): string | undefined {
  let existing = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(existing), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
      try {
        if (lstatSync(existing).isSymbolicLink()) return undefined;
      } catch {
        // doesn't exist at all: look at its parent
      }
      const parent = path.dirname(existing);
      if (parent === existing) return undefined;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** True when `target` really lands inside `root` (or is `root`), after following links. */
export function isReallyInside(root: string, target: string): boolean {
  const realRoot = realTarget(root);
  const real = realTarget(path.resolve(root, target));
  if (!realRoot || !real) return false;
  const relative = path.relative(realRoot, real);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
