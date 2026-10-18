import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShadowGit } from './shadowGit';

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'fc-ckpt-ws-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n'); // the user's own repo marker
  writeFileSync(path.join(root, 'src', 'a.js'), 'a1\r\n');
  writeFileSync(path.join(root, 'old.txt'), 'old');
  writeFileSync(path.join(root, 'logo.bin'), Buffer.from([0, 1, 2, 3, 255]));
  writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep');
  writeFileSync(path.join(root, '.gitignore'), 'secret.env\n');
  return root;
}

describe('ShadowGit checkpoints', () => {
  it('previews and restores edits, new files, deletions and binaries, without touching .git or ignored files', async () => {
    const root = workspace();
    const store = mkdtempSync(path.join(tmpdir(), 'fc-ckpt-store-'));
    const git = new ShadowGit(root, store);
    const before = await git.create('before message 1');

    writeFileSync(path.join(root, 'src', 'a.js'), 'a2\r\n');
    writeFileSync(path.join(root, 'src', 'new.js'), 'new');
    rmSync(path.join(root, 'old.txt'));
    writeFileSync(path.join(root, 'logo.bin'), Buffer.from([9, 9]));
    writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep2'); // excluded: must survive restore
    writeFileSync(path.join(root, 'secret.env'), 'KEY=1'); // ignored by the project's .gitignore

    const preview = await git.preview(before.id);
    expect(preview).toEqual(
      expect.arrayContaining([
        { path: 'src/a.js', action: 'restore' },
        { path: 'src/new.js', action: 'delete' },
        { path: 'old.txt', action: 'recreate' },
        { path: 'logo.bin', action: 'restore' },
      ]),
    );
    expect(preview.some((f) => f.path.includes('node_modules') || f.path === 'secret.env')).toBe(false);

    const safety = await git.create('before restore');
    await git.restore(before.id);
    expect(readFileSync(path.join(root, 'src', 'a.js'), 'utf8')).toBe('a2\r\n'.replace('a2', 'a1')); // line endings kept
    expect(existsSync(path.join(root, 'src', 'new.js'))).toBe(false);
    expect(readFileSync(path.join(root, 'old.txt'), 'utf8')).toBe('old');
    expect([...readFileSync(path.join(root, 'logo.bin'))]).toEqual([0, 1, 2, 3, 255]);
    expect(readFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('dep2');
    expect(readFileSync(path.join(root, 'secret.env'), 'utf8')).toBe('KEY=1');
    expect(readFileSync(path.join(root, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');

    // The restore itself can be undone.
    await git.restore(safety.id);
    expect(readFileSync(path.join(root, 'src', 'new.js'), 'utf8')).toBe('new');
    expect(existsSync(path.join(root, 'old.txt'))).toBe(false);
  }, 30_000);

  it('handles an unchanged workspace and concurrent calls', async () => {
    const root = workspace();
    const git = new ShadowGit(root, mkdtempSync(path.join(tmpdir(), 'fc-ckpt-store-')));
    const [a, b] = await Promise.all([git.create('one'), git.create('two')]);
    expect(a.id).not.toBe(b.id);
    expect(await git.preview(a.id)).toEqual([]);
    expect(await git.restore(a.id)).toEqual([]);
  }, 30_000);

  it('packs its store now and then, and never runs git gc on the project repository', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'fc-gc-ws-'));
    mkdirSync(path.join(workspace, '.git'));
    writeFileSync(path.join(workspace, '.git', 'marker'), 'project repo');
    const store = mkdtempSync(path.join(tmpdir(), 'fc-gc-store-'));
    const shadow = new ShadowGit(workspace, store);
    for (let i = 0; i < 31; i++) {
      writeFileSync(path.join(workspace, 'a.txt'), `v${i}`);
      await shadow.create(`p${i}`);
    }
    expect(readFileSync(path.join(workspace, '.git', 'marker'), 'utf8')).toBe('project repo');
    expect(existsSync(path.join(workspace, '.git', 'objects'))).toBe(false);
  }, 60_000);
});
