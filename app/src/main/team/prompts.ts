// Loads the prompt templates in app/prompts and fills their {{placeholders}}.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_NAME, APP_NAME } from '../../shared/brand';

export type PromptName = 'master' | 'planner' | 'judge' | 'reviewer' | 'compact';

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

export class PromptLibrary {
  constructor(private readonly dir: string) {}

  /** Read on every use, so edits to the .md files apply to the next thread without a restart. */
  render(name: PromptName, values: Record<string, string>): string {
    return fillTemplate(readFileSync(path.join(this.dir, `${name}.md`), 'utf8'), { appName: APP_NAME, agentName: AGENT_NAME, ...values }).trim();
  }
}

function describeOs(): string {
  if (process.platform === 'win32') {
    const build = Number(os.release().split('.')[2] ?? 0);
    return `${build >= 22000 ? 'Windows 11' : 'Windows'} (${os.release()})`;
  }
  if (process.platform === 'darwin') return `macOS (Darwin ${os.release()})`;
  return `Linux (${os.release()})`;
}

/** The shell Codex uses: PowerShell 7 when installed, else Windows PowerShell on Windows. */
function describeShell(): string {
  if (process.platform !== 'win32') return path.basename(process.env.SHELL ?? 'sh');
  const pwsh = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return existsSync(pwsh) ? 'PowerShell 7 (pwsh)' : 'Windows PowerShell 5.1';
}

/**
 * How to use the shell the commands actually run in. Models default to bash habits (`ls -la`, `head`,
 * `grep`, heredocs), which fail in PowerShell and cost a wasted round trip on nearly every task.
 */
export function shellGuide(shell: string): string {
  if (!/powershell/i.test(shell)) {
    const mac = process.platform === 'darwin';
    return [
      `Commands run in **${shell}** on ${mac ? 'macOS' : 'Linux'}. Use standard POSIX tools (\`ls\`, \`cat\`, \`rg\` or \`grep -rn\`, \`find\`) and chain with \`&&\`.`,
      mac ? "- macOS ships BSD tools: `sed -i` needs a suffix argument (`sed -i '' ...`), and `readlink -f` is missing (use `realpath`)." : '',
      '- Prefer the edit tools over `sed -i` or heredocs for changing files.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const chaining = /PowerShell 7/.test(shell)
    ? 'Chain commands with `;` (or `&&` to stop on failure).'
    : 'Chain commands with `;`. Windows PowerShell 5.1 has no `&&` or `||`.';
  return [
    `Commands run in **${shell}**, not bash or cmd. Write PowerShell from the first command; bash flags and tools fail here:`,
    '',
    '| Instead of (bash) | Use (PowerShell) |',
    '|---|---|',
    '| `ls -la` | `Get-ChildItem -Force` |',
    '| `ls -R`, `find . -name "*.ts"` | `Get-ChildItem -Recurse -File -Filter *.ts \\| Select-Object -ExpandProperty FullName` |',
    '| `cat file`, `head -n 50 file` | `Get-Content file`, `Get-Content file -TotalCount 50` |',
    '| `tail -n 20 file` | `Get-Content file -Tail 20` |',
    '| `grep -rn "text" src` | `rg -n "text" src` (ripgrep is installed and fastest) |',
    '| `wc -l file` | `(Get-Content file).Count` |',
    '| `which node` | `Get-Command node` |',
    '| `export NAME=value` | `$env:NAME = "value"` |',
    '| `mkdir -p dir` | `New-Item -ItemType Directory -Force dir` |',
    '| `cat <<EOF > file` | your file editing tool |',
    '',
    `${chaining} Quote paths with spaces. Search with \`rg\` and limit it to source folders; never run recursive searches (\`rg\`, \`findstr /S\`, \`Select-String -Recurse\`) over the whole drive, \`node_modules\` or binary files.`,
  ].join('\n');
}

const EDITING_APPLY_PATCH =
  '- **apply_patch**: the way to create, edit, and delete files. Use it for every hand-written edit. Follow the patch format in the tool description exactly: `*** Begin Patch`, then one or more `*** Add File:` / `*** Update File:` / `*** Delete File:` sections, then `*** End Patch`. Context lines must match the file exactly.';
const EDITING_TOOLS =
  '- **edit_file** and **write_file**: the way to change files. Read the file first, then call edit_file with `old_string` copied exactly from the file (same indentation and line breaks, with enough surrounding lines to be unique) and `new_string`. Use write_file to create a file or replace all of it. Do not edit files through shell commands (Set-Content, Out-File, echo >, sed).';

/** Who is driving: the user's permission mode, or a race contestant working in its own copy. */
export type PermissionContext = 'ask' | 'auto-edit' | 'full-auto' | 'race';

// Codex's own permissions message is turned off (see launch.ts), so this is all the model hears about it.
const PERMISSIONS: Record<PermissionContext, string> = {
  ask: `- You can read files and run read-only commands (listing, searching, reading files, git status/diff/log) right away.
- You **can** edit files and run any other command. Each edit and each command that could change something is shown to the user, who approves or declines it. Just make the change; it is applied once approved.`,
  'auto-edit': `- You can read files, run read-only commands, and edit files inside the project folder freely; edits apply immediately.
- Other commands that could change something (installs, deletions, network access, anything outside the project folder) are shown to the user to approve first.`,
  'full-auto': `- You have full access: edits and commands run immediately, without approval.
- Be careful with destructive commands. The app keeps restore points for files in the project, but cannot undo changes elsewhere on the system.`,
  race: `- You are working in a private copy of the project. Edit files and run commands inside it freely; nothing outside the project folder is allowed.
- No one is watching to answer questions, so finish the task on your own.`,
};

export function environmentValues(workspace: string, model: string, editTools = false, permissions: PermissionContext = 'ask'): Record<string, string> {
  return {
    permissions: PERMISSIONS[permissions],
    editing: editTools ? EDITING_TOOLS : EDITING_APPLY_PATCH,
    workspace,
    os: describeOs(),
    shell: describeShell(),
    shellGuide: shellGuide(describeShell()),
    git: existsSync(path.join(workspace, '.git')) ? 'yes' : 'no',
    date: new Date().toISOString().slice(0, 10),
    model,
  };
}
