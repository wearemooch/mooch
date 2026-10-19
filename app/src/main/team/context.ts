// What planners see of the project: a file tree, key project files, and the files open in the editor.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isReallyInside } from '../realPath';

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'out', 'build', 'target', '.smoke-data']);
const KEY_FILES = ['package.json', 'README.md', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'AGENTS.md'];

export interface ContextOptions {
  maxChars?: number;
  maxTreeEntries?: number;
  openFiles?: string[];
}

async function tree(root: string, maxEntries: number): Promise<string[]> {
  const lines: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4 || lines.length >= maxEntries) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const item of items) {
      if (lines.length >= maxEntries) {
        lines.push('  '.repeat(depth) + '…');
        return;
      }
      if (SKIP.has(item.name)) continue;
      lines.push(`${'  '.repeat(depth)}${item.name}${item.isDirectory() ? '/' : ''}`);
      if (item.isDirectory()) await walk(path.join(dir, item.name), depth + 1);
    }
  }
  await walk(root, 0);
  return lines;
}

export async function buildContext(root: string, options: ContextOptions = {}): Promise<string> {
  const maxChars = options.maxChars ?? 40_000;
  const sections: string[] = [`## Files\n\n${(await tree(root, options.maxTreeEntries ?? 400)).join('\n')}`];
  const seen = new Set<string>();
  const candidates = [...KEY_FILES.map((name) => path.join(root, name)), ...(options.openFiles ?? [])];
  let used = sections[0].length;
  for (const file of candidates) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    // A key file that is a link to something outside (README.md -> ~/.ssh/id_ed25519) is skipped.
    if (seen.has(absolute) || relative.startsWith('..') || path.isAbsolute(relative) || !isReallyInside(root, absolute)) continue;
    seen.add(absolute);
    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch {
      continue;
    }
    const budget = Math.min(12_000, maxChars - used - 200);
    if (budget < 500) break;
    const body = text.length > budget ? `${text.slice(0, budget)}\n… (truncated)` : text;
    const section = `## ${relative.replace(/\\/g, '/')}\n\n\`\`\`\n${body}\n\`\`\``;
    sections.push(section);
    used += section.length;
  }
  return sections.join('\n\n');
}
