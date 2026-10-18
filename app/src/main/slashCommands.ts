// Custom slash commands: Markdown prompt templates in ~/.mooch/commands (yours) and
// <project>/.mooch/commands (the project's). `/name args` puts the file's text in the message, with
// $ARGUMENTS replaced by the args. They are only text for Penny, never run by the app.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CustomCommand } from '../shared/ipc';

const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const MAX_BYTES = 64 * 1024;

/** Splits `---\ndescription: …\n---\nbody` into the description and the body. */
export function parseCommandFile(text: string): { description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { description: '', body: text.trim() };
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return { description, body: match[2].trim() };
}

function readFolder(dir: string, scope: CustomCommand['scope']): CustomCommand[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const commands: CustomCommand[] = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    const name = file.slice(0, -3).toLowerCase();
    if (!NAME.test(name)) continue;
    try {
      const text = readFileSync(path.join(dir, file), 'utf8');
      if (text.length > MAX_BYTES) continue;
      const { description, body } = parseCommandFile(text);
      if (body) commands.push({ name, description: description || body.split('\n')[0].slice(0, 80), body, scope });
    } catch {
      // unreadable file: skip it
    }
  }
  return commands;
}

/** The user's commands, then the project's; a project command replaces a user command of the same name. */
export function loadCustomCommands(userDir: string, projectRoot?: string): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  for (const command of readFolder(userDir, 'user')) byName.set(command.name, command);
  if (projectRoot) for (const command of readFolder(path.join(projectRoot, '.mooch', 'commands'), 'project')) byName.set(command.name, command);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
