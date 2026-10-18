// Finds programs on PATH without looking in the current folder. On Windows, spawning a bare name like
// "git" with cwd set to a project would also run a git.exe planted inside that project.
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const cache = new Map<string, string | undefined>();

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (cache.has(name)) return cache.get(name);
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((dir) => dir && path.isAbsolute(dir));
  let found: string | undefined;
  search: for (const dir of dirs) {
    for (const ext of ['', ...extensions]) {
      const candidate = path.join(dir, name + ext);
      if (ext === '' && process.platform === 'win32' && !path.extname(name)) continue;
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          found = candidate;
          break search;
        }
      } catch {
        // unreadable PATH entry
      }
    }
  }
  cache.set(name, found);
  return found;
}

/** A Windows system tool by absolute path (taskkill, etc.). */
export function systemTool(name: string): string {
  if (process.platform !== 'win32') return name;
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', `${name}.exe`);
}

/** Process ids (not this process's) whose command line runs a program inside `dir`, from `ps -eo pid=,args=` output. */
export function pidsUnder(psOutput: string, dir: string, self = process.pid): number[] {
  const root = path.posix.normalize(dir).replace(/\/+$/, '') + '/';
  return psOutput
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m && m[2].startsWith(root))
    .map((m) => Number(m[1]))
    .filter((pid) => pid !== self);
}

/**
 * Ends every process whose executable lives inside `dir`. The gateway's Python processes run from its
 * private environment folder, so this finds them even when their uv parent is already gone.
 * On Windows the folder is passed through the environment, never interpolated into the script.
 */
export function endProcessesUnder(dir: string): Promise<number> {
  if (process.platform !== 'win32') {
    return new Promise((resolve) =>
      execFile('ps', ['-eo', 'pid=,args='], { timeout: 10_000 }, (error, stdout) => {
        if (error) return resolve(0);
        const pids = pidsUnder(String(stdout), dir);
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
        resolve(pids.length);
      }),
    );
  }
  const script = [
    "$root = [IO.Path]::GetFullPath($env:FC_END_UNDER).TrimEnd([char]92) + [char]92",
    '$found = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })',
    '$found | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    '$found.Count',
  ].join('; ');
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) =>
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20_000, env: { ...process.env, FC_END_UNDER: dir } },
      (_error, stdout) => resolve(Number.parseInt(String(stdout).trim(), 10) || 0),
    ),
  );
}
