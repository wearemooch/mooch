import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pidsUnder } from './exec';
import { engineTarget, exe, runtimeFolder } from './platform';

describe('platform', () => {
  it('picks the engine build for each OS and CPU', () => {
    expect(engineTarget('win32', 'x64')).toEqual({ pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' });
    expect(engineTarget('darwin', 'arm64').triple).toBe('aarch64-apple-darwin');
    expect(engineTarget('linux', 'x64').triple).toBe('x86_64-unknown-linux-musl');
    expect(() => engineTarget('freebsd', 'x64')).toThrow(/does not support/);
    expect(exe('uv', 'win32')).toBe('uv.exe');
    expect(exe('uv', 'linux')).toBe('uv');
  });

  it('keeps the gateway runtime under Programs on Windows and in ~/.mooch elsewhere', () => {
    expect(runtimeFolder('C:/Users/pat/.mooch', 'win32', { LOCALAPPDATA: 'C:/Users/pat/AppData/Local' })).toBe(path.join('C:/Users/pat/AppData/Local', 'Programs', 'mooch-runtime'));
    expect(runtimeFolder('/home/pat/.mooch', 'linux', {})).toBe(path.join('/home/pat/.mooch', 'runtime'));
  });

  it('finds leftover gateway processes by where their program lives', () => {
    const ps = ['    1 /sbin/init', '  420 /home/pat/.mooch/runtime/bin/python -m fcc', '  421 /home/pat/.mooch/runtime-old/bin/python', ' 9999 /home/pat/.mooch/runtime/bin/uv run', '  500 bash -c /home/pat/.mooch/runtime/x'].join('\n');
    expect(pidsUnder(ps, '/home/pat/.mooch/runtime/', 9999)).toEqual([420]);
  });
});
