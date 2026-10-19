// Test fixture (not shipped): a project with a link inside it that points at a folder beside it.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** `project/link` points at `outside`, which holds secret.txt. */
export function linkedProject() {
  const base = mkdtempSync(path.join(tmpdir(), 'mooch-real-'));
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.txt'), 'DUMMY-SECRET-123');
  // Junctions need no special rights on Windows; elsewhere the type is ignored and it's a symlink.
  symlinkSync(outside, path.join(root, 'link'), 'junction');
  return { base, root, outside };
}
