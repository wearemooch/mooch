// Slash commands typed at the start of a message: the built-ins, the user's and project's custom
// commands (~/.mooch/commands, .mooch/commands) and, from Phase 4, installed skills.

export type CommandKind = 'built-in' | 'custom' | 'skill';

export interface SlashCommand {
  name: string;
  aliases?: string[];
  /** Shown after the name in the menu, e.g. "<task>". */
  args?: string;
  /** The command can't run without args. */
  needsArgs?: boolean;
  description: string;
  kind: CommandKind;
  /** Custom commands: the message template. Skills: the SKILL.md path. */
  body?: string;
  path?: string;
}

export const BUILT_INS: SlashCommand[] = [
  { name: 'help', description: 'List every command', kind: 'built-in' },
  { name: 'new', aliases: ['clear'], description: 'Start a new chat', kind: 'built-in' },
  { name: 'resume', aliases: ['sessions', 'history'], description: 'Open a past chat, from any project', kind: 'built-in' },
  { name: 'compact', description: 'Summarize the chat so far to free up context', kind: 'built-in' },
  { name: 'model', args: '<name>', description: 'Switch the model, from your next message', kind: 'built-in' },
  { name: 'mode', args: 'ask / auto / full', description: 'Switch permissions, from your next message', kind: 'built-in' },
  { name: 'undo', description: 'Put the files back to before your last message', kind: 'built-in' },
  { name: 'rewind', description: 'Undo your last message: files and chat, text back in the box', kind: 'built-in' },
  { name: 'review', description: 'Review the uncommitted git changes', kind: 'built-in' },
  { name: 'deep', args: '<task>', needsArgs: true, description: 'Plan with several models first, for this message', kind: 'built-in' },
  { name: 'race', args: '<task>', needsArgs: true, description: 'Several agents race in copies; tests pick the winner', kind: 'built-in' },
  { name: 'init', description: 'Write an AGENTS.md that explains this project to agents', kind: 'built-in' },
  { name: 'usage', aliases: ['cost'], description: 'Tokens used in this chat, and what it cost', kind: 'built-in' },
  { name: 'theme', description: 'Change the theme', kind: 'built-in' },
  { name: 'skills', description: 'See and install skills', kind: 'built-in' },
  { name: 'mcp', aliases: ['integrations'], description: 'Connect other apps and tools (MCP servers)', kind: 'built-in' },
  { name: 'commands', description: 'Open the folder for your own commands', kind: 'built-in' },
];

/** `/name rest` → { name, args }; anything else (including "/ " and "//") → undefined. */
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const match = /^\/([a-z0-9][\w:-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() } : undefined;
}

export function findCommand(commands: SlashCommand[], name: string): SlashCommand | undefined {
  const n = name.toLowerCase();
  return commands.find((c) => c.name === n) ?? commands.find((c) => c.aliases?.includes(n));
}

/** Commands for the menu while typing `/partial`: name prefix matches first, then other matches. */
export function matchCommands(commands: SlashCommand[], partial: string): SlashCommand[] {
  const p = partial.toLowerCase();
  if (!p) return commands;
  const score = (c: SlashCommand) => {
    if (c.name.startsWith(p)) return 0;
    if (c.aliases?.some((a) => a.startsWith(p))) return 1;
    if (c.name.includes(p)) return 2;
    if (c.description.toLowerCase().includes(p)) return 3;
    return 9;
  };
  return commands
    .map((c) => ({ c, s: score(c) }))
    .filter(({ s }) => s < 9)
    .sort((a, b) => a.s - b.s)
    .map(({ c }) => c);
}

/** A custom command's message: $ARGUMENTS replaced, or the args appended when the template has no placeholder. */
export function expandTemplate(body: string, args: string): string {
  if (body.includes('$ARGUMENTS')) return body.split('$ARGUMENTS').join(args);
  return args ? `${body}\n\n${args}` : body;
}

/** `/mode` accepts the mode's name or the first word of its label. */
export function parseMode(arg: string): 'ask' | 'auto-edit' | 'full-auto' | undefined {
  const a = arg.trim().toLowerCase();
  if (['ask', 'ask-first', 'ask first'].includes(a)) return 'ask';
  if (['auto', 'auto-edit', 'edit'].includes(a)) return 'auto-edit';
  if (['full', 'full-auto', 'yolo'].includes(a)) return 'full-auto';
  return undefined;
}

/** Best model for `/model <name>`: exact slug, then the model whose short name starts with or contains it. */
export function findModel(slugs: string[], query: string): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const short = (s: string) => s.split('/').pop()!.toLowerCase();
  return slugs.find((s) => s.toLowerCase() === q) ?? slugs.find((s) => short(s).startsWith(q)) ?? slugs.find((s) => s.toLowerCase().includes(q));
}

export const INIT_PROMPT = [
  'Create an AGENTS.md file at the root of this project, for coding agents (and new people) who start working here.',
  'Look around first: the folder layout, the package or build files, the README, how tests run.',
  'Keep it short and specific to this project: what it is, how to build, run and test it, where the main pieces live,',
  'and conventions you can see in the code. If an AGENTS.md exists, improve it instead.',
].join(' ');
