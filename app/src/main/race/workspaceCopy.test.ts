import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickWinner } from './race';
import { applyChanges, copyWorkspace, detectTestCommand, diffAgainst, removeCopy, removeTreeNoFollow, runTests, snapshot } from './workspaceCopy';

function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'fc-race-src-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, 'src', 'a.js'), 'a');
  writeFileSync(path.join(root, 'src', 'b.js'), 'b');
  writeFileSync(path.join(root, 'gone.txt'), 'x');
  writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  return root;
}

describe('race workspace copies', () => {
  it('copies sources, links node_modules, and applies only untouched files', async () => {
    const root = project();
    const copy = path.join(mkdtempSync(path.join(tmpdir(), 'fc-race-dst-')), 'c1');
    const baseline = await snapshot(root);
    expect([...baseline.keys()].some((f) => f.includes('node_modules'))).toBe(false);

    const { links } = await copyWorkspace(root, copy);
    expect(lstatSync(path.join(copy, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(copy, '.git'))).toBe(false);
    expect(readFileSync(path.join(copy, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('dep');

    writeFileSync(path.join(copy, 'src', 'a.js'), 'a2');
    writeFileSync(path.join(copy, 'src', 'b.js'), 'b2');
    writeFileSync(path.join(copy, 'src', 'new.js'), 'n');
    rmSync(path.join(copy, 'gone.txt'));
    const changes = await diffAgainst(copy, baseline);
    expect(changes).toEqual({ changed: [path.join('src', 'a.js'), path.join('src', 'b.js')], added: [path.join('src', 'new.js')], deleted: ['gone.txt'] });

    writeFileSync(path.join(root, 'src', 'b.js'), 'user edit'); // user changed b.js meanwhile
    const result = await applyChanges(copy, root, baseline, changes);
    expect(result.skipped).toEqual([path.join('src', 'b.js')]);
    expect(readFileSync(path.join(root, 'src', 'a.js'), 'utf8')).toBe('a2');
    expect(readFileSync(path.join(root, 'src', 'b.js'), 'utf8')).toBe('user edit');
    expect(readFileSync(path.join(root, 'src', 'new.js'), 'utf8')).toBe('n');
    expect(existsSync(path.join(root, 'gone.txt'))).toBe(false);

    await removeCopy(copy, links);
    expect(existsSync(copy)).toBe(false);
    expect(readFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('dep'); // the link target survives
  });

  it('detects and runs the test command', async () => {
    const root = project();
    expect(await detectTestCommand(root)).toBe('npm test');
    const pass = await runTests('node -e "console.log(42)"', root);
    expect(pass).toMatchObject({ passed: true, exitCode: 0, output: '42' });
    const fail = await runTests('node -e "process.exit(3)"', root);
    expect(fail).toMatchObject({ passed: false, exitCode: 3 });
  });
});


describe('pickWinner', () => {
  const c = (id: string, linesChanged: number, passed?: boolean, status: 'done' | 'failed' = 'done') => ({
    id, model: id, status, changedFiles: ['a'], linesChanged, test: passed === undefined ? undefined : { command: 't', passed, exitCode: passed ? 0 : 1, output: '' },
  });
  it('prefers passing tests, then the smallest change', () => {
    expect(pickWinner([c('big', 40, true), c('small', 2, false), c('mid', 10, true)])).toBe('mid');
  });
  it('breaks ties by speed', () => {
    expect(pickWinner([{ ...c('slow', 2, true), durationMs: 110_000 }, { ...c('fast', 2, true), durationMs: 48_000 }])).toBe('fast');
  });
  it('picks nobody when tests exist but all fail', () => {
    expect(pickWinner([c('a', 1, false), c('b', 2, false)])).toBeUndefined();
  });
  it('uses the smallest finished change when there are no tests', () => {
    expect(pickWinner([c('a', 9), c('b', 3), c('x', 1, undefined, 'failed')])).toBe('b');
  });
});

describe('removeTreeNoFollow', () => {
  it('deletes a stale copy but never what its junctions point to', async () => {
    const original = project();
    const copy = mkdtempSync(path.join(tmpdir(), 'fc-race-stale-'));
    await copyWorkspace(original, copy); // links node_modules back to the original
    await removeTreeNoFollow(copy);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(path.join(original, 'node_modules', 'dep'))).toBe(true);
  });
});
