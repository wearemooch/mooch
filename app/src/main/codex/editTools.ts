// mooch's own file-editing tools, offered to Codex as dynamic (client-implemented) tools.
// Plain JSON arguments and exact-text replacement are much easier for non-OpenAI models than
// Codex's freeform apply_patch grammar, which they have to embed inside a JSON string.
import { createTwoFilesPatch } from 'diff';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileUpdateChange } from '../../shared/ipc';
import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec';

export const EDIT_TOOL_NAMES = new Set(['edit_file', 'write_file']);

export const EDIT_TOOL_SPECS: DynamicToolSpec[] = [
  {
    type: 'function',
    name: 'edit_file',
    description:
      'Replace exact text in an existing file. old_string must match the file exactly, including whitespace and indentation, ' +
      'and must appear exactly once unless replace_all is true. Include enough surrounding lines to make it unique. ' +
      'Read the file first. Use write_file to create a new file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project folder.' },
        old_string: { type: 'string', description: 'The exact text to replace.' },
        new_string: { type: 'string', description: 'The text to put in its place.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one.' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'write_file',
    description: 'Create a file, or replace its entire content. Prefer edit_file for changes to existing files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project folder.' },
        content: { type: 'string', description: 'The complete file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
];

export interface EditPlan {
  absolute: string;
  relative: string;
  before: string | undefined;
  after: string;
  change: FileUpdateChange;
}

export class EditError extends Error {}

function resolveInside(root: string, file: unknown): { absolute: string; relative: string } {
  if (typeof file !== 'string' || !file.trim()) throw new EditError('path is required.');
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new EditError(`${file} is outside the project folder.`);
  return { absolute, relative };
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  for (let at = text.indexOf(search); at >= 0; at = text.indexOf(search, at + search.length)) count++;
  return count;
}

/** Works out the edit without writing anything, so it can be shown and approved first. */
export async function planEdit(root: string, tool: string, args: Record<string, unknown>): Promise<EditPlan> {
  const { absolute, relative } = resolveInside(root, args.path);
  const exists = existsSync(absolute);
  const before = exists ? (await readFile(absolute, 'utf8')) : undefined;
  let after: string;

  if (tool === 'write_file') {
    if (typeof args.content !== 'string') throw new EditError('content is required.');
    after = args.content;
  } else if (tool === 'edit_file') {
    if (before === undefined) throw new EditError(`${relative} does not exist. Use write_file to create it.`);
    const oldString = args.old_string;
    const newString = args.new_string;
    if (typeof oldString !== 'string' || typeof newString !== 'string') throw new EditError('old_string and new_string are required.');
    if (!oldString) throw new EditError('old_string is empty. Use write_file to replace a whole file.');
    if (oldString === newString) throw new EditError('old_string and new_string are identical; nothing to change.');
    // Models often send \n while a Windows file uses \r\n; match either way and keep the file's style.
    const crlf = before.includes('\r\n');
    const toFile = (s: string) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
    const search = before.includes(oldString) ? oldString : toFile(oldString);
    const replacement = search === oldString ? newString : toFile(newString);
    const count = countOccurrences(before, search);
    if (count === 0) throw new EditError(`old_string was not found in ${relative}. Read the file again and copy the text exactly.`);
    if (count > 1 && args.replace_all !== true) {
      throw new EditError(`old_string appears ${count} times in ${relative}. Add surrounding lines to make it unique, or set replace_all.`);
    }
    after = args.replace_all === true ? before.split(search).join(replacement) : before.replace(search, () => replacement);
  } else {
    throw new EditError(`Unknown tool ${tool}.`);
  }

  const name = relative.replace(/\\/g, '/');
  const change: FileUpdateChange = {
    path: relative,
    kind: before === undefined ? { type: 'add' } : { type: 'update', move_path: null },
    diff: createTwoFilesPatch(`a/${name}`, `b/${name}`, before ?? '', after, '', '', { context: 3 }),
  };
  return { absolute, relative, before, after, change };
}

export async function applyEdit(plan: EditPlan): Promise<void> {
  await mkdir(path.dirname(plan.absolute), { recursive: true });
  await writeFile(plan.absolute, plan.after, 'utf8');
}

export function editSummary(plan: EditPlan): string {
  const added = plan.change.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = plan.change.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return `${plan.before === undefined ? 'Created' : 'Updated'} ${plan.relative} (+${added} -${removed}).`;
}
