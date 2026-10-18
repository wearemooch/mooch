import { describe, expect, it } from 'vitest';
import { referencesOutside, workspacePolicy } from './policy';

const root = 'C:\\work\\copy1';
const ps = (inner: string) => String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command '` + inner + "'";

describe('workspacePolicy', () => {
  it('ask: only read-only commands run without asking', () => {
    const policy = workspacePolicy(root, 'ask');
    expect(policy({ type: 'command', command: ps('cat math.js') })).toBe('accept');
    expect(policy({ type: 'command', command: ps('npm test') })).toBeUndefined();
    expect(policy({ type: 'fileChange', paths: [`${root}\\math.js`] })).toBeUndefined();
  });

  it('auto-edit: edits inside the project are accepted, others ask', () => {
    const policy = workspacePolicy(root, 'auto-edit');
    expect(policy({ type: 'fileChange', paths: ['math.js', `${root}\\src\\a.js`] })).toBe('accept');
    expect(policy({ type: 'fileChange', paths: ['C:\\tmp\\x.txt'] })).toBeUndefined();
    expect(policy({ type: 'command', command: ps('npm test') })).toBeUndefined();
  });

  it('race: unattended, declines anything pointing outside the copy', () => {
    const policy = workspacePolicy(root, 'race');
    expect(policy({ type: 'command', command: ps('npm test') })).toBe('accept');
    expect(policy({ type: 'command', command: ps('Remove-Item C:\\Users\\me\\file.txt') })).toBe('decline');
    expect(policy({ type: 'command', command: ps('cat ..\\..\\secret.txt') })).toBe('decline');
    expect(policy({ type: 'fileChange', paths: ['C:/tmp/test.txt'] })).toBe('decline');
    expect(policy({ type: 'fileChange', paths: ['math.js'] })).toBe('accept');
  });

  it('spots outside references', () => {
    expect(referencesOutside(root, ps(`type ${root}\\math.js`))).toBe(false);
    expect(referencesOutside(root, ps('node test.js'))).toBe(false);
    expect(referencesOutside(root, ps('echo hi > D:\\x.txt'))).toBe(true);
  });

  it('treats home, shares, variables, provider drives and rooted paths as outside', () => {
    for (const cmd of [
      'cat ~/.ssh/id_rsa', 'Get-Content ~\\.aws\\credentials', 'type \\\\evil-host\\share\\x', 'ls //server/share',
      'Get-ChildItem env:', 'gci Env:\\', 'Get-Item HKCU:\\Software', 'cat $env:USERPROFILE\\x', 'type %USERPROFILE%\\x',
      'type C:secret.txt', 'cat /etc/passwd', 'type \\Windows\\win.ini', 'ls /Users',
    ]) {
      expect(referencesOutside(root, ps(cmd)), cmd).toBe(true);
    }
    for (const cmd of ['dir /s', 'findstr /S /I /c:"x y" *.js', 'ls src/a', 'rg -n foo src\\lib', 'git log -n 5', 'curl https://example.com/x']) {
      expect(referencesOutside(root, ps(cmd)), cmd).toBe(false);
    }
  });

  it('on macOS and Linux: allows paths in the project, refuses everything around it', () => {
    const home = '/home/pat/proj';
    const sh = (cmd: string) => `/bin/bash -lc '${cmd}'`;
    for (const cmd of ['ls -la /home/pat/proj/src', 'cat src/app.ts', 'rg -n foo /home/pat/proj', 'git status']) {
      expect(referencesOutside(home, sh(cmd)), cmd).toBe(false);
    }
    for (const cmd of [
      'cat /home/pat/.ssh/id_rsa', 'ls /home/pat/proj/../other', 'cat ~/.aws/credentials', 'ls ~root', 'cat $HOME/.netrc', 'ls ${XDG_CONFIG_HOME}',
      'cat /etc/shadow', 'ls /home/pat/project-two', 'cat /proc/self/environ',
    ]) {
      expect(referencesOutside(home, sh(cmd)), cmd).toBe(true);
    }
  });
});
