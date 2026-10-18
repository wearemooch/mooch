import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Workspace } from './workspace';

describe('Workspace', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'free-code-ws-'));
  const workspace = new Workspace(root, () => {});

  it('reads and writes inside the root', async () => {
    await workspace.write('src/a.txt', 'hello');
    expect(await workspace.read(path.join(root, 'src', 'a.txt'))).toBe('hello');
    const entries = await workspace.list(root);
    expect(entries).toEqual([{ name: 'src', path: path.join(root, 'src'), isDirectory: true }]);
  });

  it('refuses paths that escape the root', async () => {
    expect(() => workspace.resolve('../outside.txt')).toThrow(/outside the workspace/);
    await expect(workspace.write(path.join(root, '..', 'x.txt'), 'no')).rejects.toThrow(/outside the workspace/);
  });
});
