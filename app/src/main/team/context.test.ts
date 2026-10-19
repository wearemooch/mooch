import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkedProject } from '../linkedProject.fixture';
import { loadCustomCommands } from '../slashCommands';
import { buildContext } from './context';

describe('project content that links outside the project', () => {
  it('planner context skips files reached through a link', async () => {
    const { root } = linkedProject();
    writeFileSync(path.join(root, 'README.md'), '# Project');
    const context = await buildContext(root, { openFiles: [path.join('link', 'secret.txt')] });
    expect(context).toContain('# Project');
    expect(context).not.toContain('DUMMY-SECRET-123');
  });

  it('planner context skips a key file that is itself a link, where the OS allows file links', async () => {
    const { root, outside } = linkedProject();
    try {
      symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'AGENTS.md'), 'file');
    } catch {
      return; // Windows without symlink rights: the folder-link case above covers the same check
    }
    expect(await buildContext(root)).not.toContain('DUMMY-SECRET-123');
  });

  it("project slash commands can't be links to files elsewhere", () => {
    const { root, outside, base } = linkedProject();
    writeFileSync(path.join(outside, 'leak.md'), 'DUMMY-SECRET-123');
    mkdirSync(path.join(root, '.mooch'));
    // The whole commands folder is a link to the outside folder.
    symlinkSync(outside, path.join(root, '.mooch', 'commands'), 'junction');
    const userDir = path.join(base, 'user-commands');
    mkdirSync(userDir);
    writeFileSync(path.join(userDir, 'mine.md'), 'my own command');
    const commands = loadCustomCommands(userDir, root);
    expect(commands.map((c) => c.name)).toEqual(['mine']);
  });
});
