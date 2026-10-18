import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { carryOverData } from './migrate';
import { moochHome, moochPaths } from './paths';

function oldFolder(root: string, name: string, review: boolean) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'fcc-home', '.fcc'), { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ review }));
  writeFileSync(path.join(dir, 'fcc-home', '.fcc', '.env'), `NVIDIA_NIM_API_KEY=${name}`);
  return dir;
}

describe('carryOverData', () => {
  it('copies settings and gateway keys into a new ~/.mooch, once', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mooch-migrate-'));
    const appData = oldFolder(root, 'mooch', true);
    const home = path.join(root, '.mooch');
    expect(carryOverData([appData], home).sort()).toEqual([path.join('gateway', '.fcc', '.env'), 'settings.json'].sort());
    expect(readFileSync(path.join(home, 'gateway', '.fcc', '.env'), 'utf8')).toBe('NVIDIA_NIM_API_KEY=mooch');
    writeFileSync(path.join(home, 'settings.json'), '{"review":false}');
    expect(carryOverData([appData], home)).toEqual([]); // ~/.mooch exists now: never overwritten
    expect(readFileSync(path.join(home, 'settings.json'), 'utf8')).toBe('{"review":false}');
  });

  it('takes the newest old folder that has data, and skips missing ones', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mooch-migrate-'));
    const older = oldFolder(root, 'free-code', false);
    const home = path.join(root, '.mooch');
    expect(carryOverData([path.join(root, 'mooch'), older], home)).toContain('settings.json');
    expect(readFileSync(path.join(home, 'gateway', '.fcc', '.env'), 'utf8')).toBe('NVIDIA_NIM_API_KEY=free-code');
  });
});

describe('moochPaths', () => {
  it('lives in ~/.mooch unless MOOCH_HOME says otherwise', () => {
    expect(moochHome({}, path.join('C:', 'Users', 'pat'))).toBe(path.join('C:', 'Users', 'pat', '.mooch'));
    expect(moochHome({ MOOCH_HOME: '  ' }, '/home/pat')).toBe(path.join('/home/pat', '.mooch'));
    expect(moochHome({ MOOCH_HOME: path.join(tmpdir(), 'portable') }, '/home/pat')).toBe(path.resolve(tmpdir(), 'portable'));
    const paths = moochPaths(path.join('x', '.mooch'));
    expect(paths.engine).toBe(path.join('x', '.mooch', 'engine'));
    expect(paths.mcp).toBe(path.join('x', '.mooch', 'mcp.json'));
  });
});
