import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkedProject } from '../linkedProject.fixture';
import { referencesOutside, touchesSharedDependencies, workspacePolicy } from './policy';

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

  it('only answers plain commands that run in the project', () => {
    for (const mode of ['ask', 'race'] as const) {
      const policy = workspacePolicy(root, mode);
      const refused = mode === 'race' ? 'decline' : undefined;
      expect(policy({ type: 'command', command: ps('cat id_rsa'), cwd: 'C:\\Users\\me\\.ssh' }), mode).toBe(refused);
      expect(policy({ type: 'command', command: ps('cat math.js'), kind: 'writeStdin' }), mode).toBe(refused);
      expect(policy({ type: 'command', command: ps('cat math.js'), extraPermissions: true }), mode).toBe(refused);
      expect(policy({ type: 'command', command: ps('cat math.js'), cwd: `${root}\\src`, kind: 'command' }), mode).toBe('accept');
    }
    // Race: a write somewhere else, given as a relative path in an outside folder.
    expect(workspacePolicy(root, 'race')({ type: 'command', command: ps('Remove-Item -Recurse *'), cwd: 'C:\\Users\\me\\project' })).toBe('decline');
  });

  it('auto-edit: edits to git metadata ask', () => {
    const policy = workspacePolicy(root, 'auto-edit');
    for (const file of ['.git\\config', `${root}\\.git\\hooks\\pre-commit`, '.gitattributes', 'sub\\.gitmodules']) {
      expect(policy({ type: 'fileChange', paths: [file] }), file).toBeUndefined();
    }
    expect(policy({ type: 'fileChange', paths: ['src\\git.js'] })).toBe('accept');
  });

  it('git reads ask when the repository config could run a program', () => {
    const repo = (config: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'mooch-git-'));
      mkdirSync(path.join(dir, '.git'));
      writeFileSync(path.join(dir, '.git', 'config'), config);
      return dir;
    };
    const clean = repo('[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = https://example.com/x.git\n[branch "clean-up"]\n\tremote = origin\n');
    const sh = (cmd: string) => (process.platform === 'win32' ? ps(cmd) : `/bin/bash -lc '${cmd}'`);
    expect(workspacePolicy(clean, 'ask')({ type: 'command', command: sh('git status') })).toBe('accept');
    for (const config of [
      '[core]\n\tfsmonitor = ./evil.sh\n',
      '[diff]\n\texternal = ./evil.sh\n',
      '[diff "pdf"]\n\ttextconv = ./evil.sh\n',
      '[filter "x"]\n\tclean = ./evil.sh\n',
      '[include]\n\tpath = ../elsewhere\n',
      '[CORE]\n  FsMonitor\n',
    ]) {
      const dir = repo(config);
      expect(workspacePolicy(dir, 'ask')({ type: 'command', command: sh('git status') }), config).toBeUndefined();
      // Other read-only commands are unaffected.
      expect(workspacePolicy(dir, 'ask')({ type: 'command', command: sh('cat README.md') }), config).toBe('accept');
    }
  });

  it('race: the shared dependency folders stay off limits', () => {
    // In a real copy, node_modules is a link to the real project's.
    const { root: copy } = linkedProject();
    symlinkSync(path.join(copy, 'link'), path.join(copy, 'node_modules'), 'junction');
    const policy = workspacePolicy(copy, 'race');
    expect(policy({ type: 'fileChange', paths: [path.join(copy, 'node_modules', 'dep', 'index.js')] })).toBe('decline');
    expect(policy({ type: 'fileChange', paths: [path.join(copy, 'src', 'a.js')] })).toBe('accept');
    for (const cmd of ['npm install lodash', 'npm i', 'pnpm add x', 'yarn', 'pip install requests', 'python -m pip install x', 'uv sync', 'rm -rf node_modules/x']) {
      expect(touchesSharedDependencies(cmd), cmd).toBe(true);
      expect(policy({ type: 'command', command: `/bin/bash -lc '${cmd}'` }), cmd).toBe('decline');
    }
    for (const cmd of ['npm test', 'npm run build', 'node test.js', 'yarn test', 'python -m pytest -q']) {
      expect(touchesSharedDependencies(cmd), cmd).toBe(false);
    }
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
