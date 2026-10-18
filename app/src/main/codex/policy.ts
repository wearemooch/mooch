// mooch's own approval rules. Codex's workspace-write sandbox silently falls back to read-only on
// Windows unless an elevated setup has been run, so threads run with Codex asking for every write
// and this policy answers what it safely can.
import path from 'node:path';
import { displayCommand, isReadOnlyCommand } from '../../shared/commands';
import type { ApprovalDecision } from '../../shared/ipc';

export type PolicyMode = 'ask' | 'auto-edit' | 'race';

export type ApprovalQuestion = { type: 'command'; command: string } | { type: 'fileChange'; paths: string[] } | { type: 'mcpTool'; server: string; tool: string };

/** A decision to answer automatically, or undefined to ask the user. */
export type ApprovalPolicy = (question: ApprovalQuestion) => ApprovalDecision | undefined;

export function isInside(root: string, target: string): boolean {
  // Path rules follow the project's own path, not the OS running the check (tests run on all three).
  const p = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : root.startsWith('/') ? path.posix : path;
  const relative = p.relative(p.resolve(root), p.resolve(root, target));
  return !relative.startsWith('..') && !p.isAbsolute(relative);
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

export function workspacePolicy(root: string, mode: PolicyMode): ApprovalPolicy {
  return (question) => {
    // Integrations' tools that write something always ask (the engine runs read-only ones by itself);
    // races decline them, since copies shouldn't touch outside services.
    if (question.type === 'mcpTool') return mode === 'race' ? 'decline' : undefined;
    if (question.type === 'command') {
      // Even reads outside the project are never automatic.
      if (referencesOutside(root, question.command)) return mode === 'race' ? 'decline' : undefined;
      if (isReadOnlyCommand(question.command)) return 'accept';
      return mode === 'race' ? 'accept' : undefined;
    }
    const inside = question.paths.length > 0 && question.paths.every((p) => isInside(root, p));
    if (mode === 'ask') return undefined;
    if (inside) return 'accept';
    return mode === 'race' ? 'decline' : undefined;
  };
}
