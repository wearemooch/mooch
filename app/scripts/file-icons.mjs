// Copies the file-tree icons mooch uses from material-icon-theme (MIT) into src/renderer/fileIcons,
// with their "_light" variants where the theme has them. Run after changing src/renderer/fileIcons.ts:
//   node scripts/file-icons.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '..');
const source = path.join(appRoot, 'node_modules', 'material-icon-theme', 'icons');
const target = path.join(appRoot, 'src', 'renderer', 'fileIcons');

// The names are read from the TypeScript source so the two can't drift apart.
const mapping = readFileSync(path.join(appRoot, 'src', 'renderer', 'fileIcons.ts'), 'utf8');
const names = new Set(['file', 'folder', 'folder-open']);
for (const [, value] of mapping.matchAll(/'((?:folder-)?[a-z0-9_-]+)'/g)) {
  if (existsSync(path.join(source, `${value}.svg`))) names.add(value);
}
for (const name of [...names]) if (name.startsWith('folder-') && !name.endsWith('-open')) names.add(`${name}-open`);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
let copied = 0;
for (const name of names) {
  for (const file of [`${name}.svg`, `${name}_light.svg`]) {
    if (!existsSync(path.join(source, file))) continue;
    copyFileSync(path.join(source, file), path.join(target, file));
    copied++;
  }
}
copyFileSync(path.join(source, '..', 'LICENSE'), path.join(target, 'LICENSE'));
console.log(`[file-icons] ${copied} icons → ${path.relative(appRoot, target)} (${readdirSync(target).length - 1} files)`);
