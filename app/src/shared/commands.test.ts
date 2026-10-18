import { describe, expect, it } from 'vitest';
import { displayCommand, isReadOnlyCommand } from './commands';

const ps = (inner: string) => String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command '` + inner.replace(/'/g, "''") + "'";

describe('isReadOnlyCommand', () => {
  it('allows plain reads, searches and read-only git', () => {
    for (const cmd of [
      'ls', 'ls -la', 'cat math.js', 'Get-Content math.js | Select-Object -First 20', 'rg "add" src', 'git status', 'git diff HEAD',
      'dir /s', 'findstr /S /I "x" *.js', 'git branch -a', 'git remote -v', 'sort names.txt', 'find . -name "*.ts"',
    ]) {
      expect(isReadOnlyCommand(ps(cmd)), cmd).toBe(true);
    }
  });

  it('asks for anything that can write or run code', () => {
    for (const cmd of [
      'npm test', 'node test.js', 'rm math.js', 'echo hi > a.txt', 'cat a | Set-Content b', 'git commit -m x', 'git checkout .',
      'ls; Remove-Item x', 'echo $(Remove-Item x)', 'Get-ChildItem | ForEach-Object { Remove-Item $_ }', 'find . -delete', 'python -c "print(1)"',
      // statements on separate lines, nested commands, call operator
      'ls\nRemove-Item x', 'ls\r\nrm x', 'Get-Content (Remove-Item x)', 'ls & calc', '& calc',
      // reading secrets from variables
      'echo $env:OPENROUTER_API_KEY', 'echo %PATH%', 'Write-Output $HOME',
      // read-only commands with writing or executing options
      'sort in.txt -o out.txt', 'sort in.txt /o out.txt', 'rg --pre ./evil.bat x', 'rg --pre=evil x', 'find . -fprint out.txt',
      'git diff --output=patch.txt', 'git log --output patch.txt', 'git grep -Oevil x', 'git grep --open-files-in-pager=evil x',
      'git diff --ext-diff', 'git branch evil', 'git branch -D main', 'git remote add x https://e.vil', 'git -c core.pager=evil log',
    ]) {
      expect(isReadOnlyCommand(ps(cmd)), cmd).toBe(false);
    }
  });

  it('displays the inner command', () => {
    expect(displayCommand(ps("echo 'hi'"))).toBe("echo 'hi'");
  });

  it('unwraps the shells Codex uses on macOS and Linux', () => {
    expect(displayCommand("/bin/bash -lc 'ls -la'")).toBe('ls -la');
    expect(displayCommand('/bin/zsh -lc "git status"')).toBe('git status');
    expect(displayCommand("bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(isReadOnlyCommand("/bin/bash -lc 'rg -n foo src | head -20'")).toBe(true);
    expect(isReadOnlyCommand("/bin/bash -lc 'cat a > b'")).toBe(false);
    expect(isReadOnlyCommand("/bin/zsh -lc 'find . -name x -delete'")).toBe(false);
    expect(isReadOnlyCommand("/bin/bash -lc 'ls; rm -rf src'")).toBe(false);
    expect(isReadOnlyCommand("/bin/bash -lc 'cat $(echo secret)'")).toBe(false);
  });
});
