// mooch's own approval rules. Codex's workspace-write sandbox silently falls back to read-only on
// Windows unless an elevated setup has been run, so threads run with Codex asking for every write
// and this policy answers what it safely can.
import path from 'node:path';
import { commandNames, displayCommand, isReadOnlyCommand } from '../../shared/commands';
import type { ApprovalDecision } from '../../shared/ipc';
import { isReallyInside } from '../realPath';
import { gitConfigRunsPrograms } from './gitConfig';

export type PolicyMode = 'ask' | 'auto-edit' | 'race';

export interface CommandQuestion {
  type: 'command';
  command: string;
  /** Where the command runs; commands elsewhere are never automatic. */
  cwd?: string;
  /** 'writeStdin' is input to a terminal that is already running, not a new command. */
  kind?: string;
  /** The command asks for more than the sandbox allows (network, extra folders). */
  extraPermissions?: boolean;
}

export type ApprovalQuestion = CommandQuestion | { type: 'fileChange'; paths: string[] } | { type: 'mcpTool'; server: string; tool: string };

/** A decision to answer automatically, or undefined to ask the user. */
export type ApprovalPolicy = (question: ApprovalQuestion) => ApprovalDecision | undefined;

/**
 * True when `target` is inside `root`. When the path belongs to this OS, links are followed too, so a
 * symlink or junction in the project that points elsewhere counts as outside.
 */
export function isInside(root: string, target: string): boolean {
  // Path rules follow the project's own path, not the OS running the check (tests run on all three).
  const p = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : root.startsWith('/') ? path.posix : path;
  const relative = p.relative(p.resolve(root), p.resolve(root, target));
  if (relative.startsWith('..') || p.isAbsolute(relative)) return false;
  return p !== path || isReallyInside(root, target);
}

/** Git's own metadata: editing it can make later git commands run programs, so edits there always ask. */
export function isGitMetadata(target: string): boolean {
  const parts = target.split(/[\\/]+/).map((part) => part.toLowerCase());
  const name = parts[parts.length - 1];
  return parts.includes('.git') || name === '.gitattributes' || name === '.gitmodules';
}

/** A token that names a path from the drive root (`\Windows`, `/etc/hosts`), not a cmd switch like `/s` or `/c:x`. */
function isRootedPath(token: string): boolean {
  if (token.startsWith('\\')) return true;
  return token.startsWith('/') && !/^\/[A-Za-z?-]{1,3}(:.*)?$/.test(token);
}

/**
 * True when the command may reach outside `root`: absolute or drive-relative paths elsewhere, `..`,
 * the home folder, network shares (which would also leak Windows credentials), environment variables
 * and PowerShell provider drives such as `env:` or `HKCU:`.
 */
export function referencesOutside(root: string, command: string): boolean {
  const inner = displayCommand(command);
  if (/(^|[\s'"=\\/])\.\.([\\/]|$)/.test(inner)) return true;
  if (/(^|[\s'"=(])(\\\\|\/\/)/.test(inner)) return true; // UNC: \\server\share, //server/share
  if (/(^|[\s'"=(])~([\\/\s'"]|[A-Za-z_]|$)/.test(inner)) return true; // ~, ~/x, ~user
  if (/\$env:|\$\{?(home|profile)\b|%[A-Za-z_][\w()]*%/i.test(inner)) return true;
  // Any shell variable can name a folder elsewhere ($HOME, ${XDG_CONFIG_HOME}, $OLDPWD…).
  if (/\$\{?[A-Za-z_]/.test(inner)) return true;
  if (/(^|[\s'"=(])(env|variable|function|alias|hklm|hkcu|hkey_[a-z_]+|cert|wsman|registry):/i.test(inner)) return true;
  if (/(^|[\s'"=(])[A-Za-z]:(?![\\/])/.test(inner)) return true; // drive-relative: C:foo, or a bare C:
  // Not preceded by a letter, so the "s:/" in https:// isn't read as drive S:.
  const absolute = inner.match(/(?<![\w+.-])[A-Za-z]:[\\/][^\s'"|;&]*/g) ?? [];
  if (absolute.some((p) => !isInside(root, p))) return true;
  const tokens = inner.split(/[\s|;&=,]+/).map((t) => t.replace(/^["']|["']$/g, ''));
  // On macOS and Linux the project itself has a rooted path; only rooted paths elsewhere are outside.
  return tokens.some((t) => isRootedPath(t) && !(root.startsWith('/') && t.startsWith('/') && isInside(root, t)));
}

/**
 * In a race copy, node_modules and virtual environments are links to the real project's (copying
 * them would be too slow), so installing packages or writing there would change the real project.
 */
export function touchesSharedDependencies(command: string): boolean {
  const inner = displayCommand(command);
  if (/(^|[\s'"=\\/])(node_modules|\.venv|venv)([\\/\s'"]|$)/i.test(inner)) return true;
  return (
    /\b(npm|pnpm|bun)\s+(i|in|install|ci|add|remove|rm|r|uninstall|un|update|up|upgrade|link|ln|unlink|rebuild|dedupe|prune)\b/i.test(inner) ||
    /\byarn(\s*$|\s*[|;&]|\s+(install|add|remove|upgrade|up|link|unlink|dedupe)\b)/i.test(inner) ||
    /\b(pip3?|uv\s+pip)\s+(install|uninstall)\b|\bpython[\d.]*\s+-m\s+pip\b|\b(uv|poetry|pdm|pipenv)\s+(add|remove|sync|install|lock|update)\b/i.test(inner)
  );
}

export function workspacePolicy(root: string, mode: PolicyMode): ApprovalPolicy {
  return (question) => {
    // Integrations' tools that write something always ask (the engine runs read-only ones by itself);
    // races decline them, since copies shouldn't touch outside services.
    if (question.type === 'mcpTool') return mode === 'race' ? 'decline' : undefined;
    const refuse = mode === 'race' ? 'decline' : undefined;
    if (question.type === 'command') {
      // Only a plain new command, run in the project with the normal sandbox, can be answered here.
      if ((question.kind && question.kind !== 'command') || question.extraPermissions) return refuse;
      if (question.cwd && !isInside(root, question.cwd)) return refuse;
      // Even reads outside the project are never automatic.
      if (referencesOutside(root, question.command)) return refuse;
      if (isReadOnlyCommand(question.command) && !(commandNames(question.command).includes('git') && gitConfigRunsPrograms(question.cwd ?? root))) return 'accept';
      if (mode === 'race') return touchesSharedDependencies(question.command) ? 'decline' : 'accept';
      return undefined;
    }
    const inside = question.paths.length > 0 && question.paths.every((p) => isInside(root, p));
    if (mode === 'ask') return undefined;
    if (mode === 'auto-edit' && question.paths.some(isGitMetadata)) return undefined;
    if (inside) return 'accept';
    return refuse;
  };
}
