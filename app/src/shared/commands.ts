// Shell command helpers shared by the main process (auto-approval) and the renderer (display).

/**
 * Codex wraps commands in the shell: `"...\pwsh.exe" -Command '...'` on Windows, `/bin/bash -lc '...'` or
 * `/bin/zsh -lc "..."` on macOS and Linux. Return just the inner command.
 */
export function displayCommand(command: string): string {
  const trimmed = command.trim();
  const powershell = /^"?[^"]*?(?:pwsh|powershell)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+([\s\S]*)$/i.exec(trimmed);
  if (powershell) {
    const inner = powershell[1].trim();
    return /^'.*'$/s.test(inner) ? inner.slice(1, -1).replace(/''/g, "'") : inner.replace(/^"(.*)"$/s, '$1');
  }
  const posix = /^(?:\/[\w/.-]*\/)?(?:bash|zsh|sh|dash)\s+-l?c\s+([\s\S]*)$/.exec(trimmed);
  if (posix) {
    const inner = posix[1].trim();
    // Single quotes in POSIX shells: the content is literal, and '\'' ends, escapes and reopens a quote.
    if (/^'.*'$/s.test(inner)) return inner.slice(1, -1).replace(/'\\''/g, "'");
    return inner.replace(/^"(.*)"$/s, '$1');
  }
  return command;
}

// Commands that only read. Anything not listed here is treated as possibly writing.
const READ_ONLY = new Set(
  [
    'ls', 'dir', 'gci', 'get-childitem', 'cat', 'type', 'gc', 'get-content', 'head', 'tail', 'wc', 'pwd', 'get-location',
    'rg', 'grep', 'findstr', 'select-string', 'sls', 'tree', 'test-path', 'resolve-path', 'get-item', 'gi', 'measure-object',
    'sort', 'sort-object', 'select-object', 'select', 'where-object', 'where', 'format-list', 'format-table', 'fl', 'ft',
    'cut', 'echo', 'write-output', 'get-command', 'which', 'stat', 'file', 'du', 'nl', 'find', 'realpath', 'basename', 'dirname',
  ].map((c) => c.toLowerCase()),
);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'branch', 'ls-files', 'grep', 'rev-parse', 'blame', 'remote']);
/** `git branch` and `git remote` also create, rename and delete; only their listing forms are read-only. */
const GIT_LISTING_FLAGS = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--list', '-l', '--show-current']);

/** Arguments that make an otherwise read-only command write files or run other programs. */
const WRITING_ARGS: Record<string, RegExp> = {
  // GNU `sort -o file` and Windows `sort /o file` write their output.
  sort: /^(-o|--output|\/o)/i,
  // `rg --pre cmd` runs cmd on every file.
  rg: /^--pre\b/,
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  // `--output` writes a file, `-O`/`--open-files-in-pager` runs a program, external diffs and textconv run helpers.
  git: /^(--output|-o$|-O|--open-files-in-pager|--ext-diff|--textconv)/,
};

/**
 * True when every segment of the command is a known read-only command. Redirection, subshells,
 * variables, multiple lines and anything unrecognized make it false, so the user is asked as usual.
 */
export function isReadOnlyCommand(command: string): boolean {
  const inner = displayCommand(command).trim();
  // Newlines separate statements; `(` and `$(` run nested commands; `$`/`%` read variables such as API keys.
  if (!inner || /[<>`(){}$%\r\n]|@\(/.test(inner)) return false;
  const segments = inner.split(/\|\||&&|[|;&]/).map((s) => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(isReadOnlySegment);
}

function isReadOnlySegment(segment: string): boolean {
  const [first, ...args] = segment.split(/\s+/);
  const name = first.toLowerCase().replace(/\.exe$/, '');
  const writing = WRITING_ARGS[name];
  if (writing && args.some((arg) => writing.test(arg.replace(/^["']|["']$/g, '')))) return false;
  if (name === 'git') {
    const [sub, ...rest] = args;
    const subcommand = (sub ?? '').toLowerCase();
    if (!READ_ONLY_GIT.has(subcommand)) return false;
    if (subcommand === 'branch' || subcommand === 'remote') return rest.every((arg) => GIT_LISTING_FLAGS.has(arg.toLowerCase()));
    return true;
  }
  return READ_ONLY.has(name);
}
