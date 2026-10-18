import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { environmentValues, fillTemplate, PromptLibrary } from './prompts';

describe('prompts', () => {
  it('fills known placeholders and leaves unknown ones visible', () => {
    expect(fillTemplate('a {{x}} b {{y}}', { x: '1' })).toBe('a 1 b {{y}}');
  });

  it('renders the master prompt with no placeholders left', () => {
    const library = new PromptLibrary(path.resolve(__dirname, '../../../prompts'));
    const text = library.render('master', environmentValues('C:\\proj', 'nvidia_nim/x'));
    expect(text).toContain('Project folder: C:\\proj');
    expect(text).toContain('Underlying model (mention only if asked): nvidia_nim/x');
    expect(text).toContain('Your name is **Penny**');
    expect(text).toContain("I'm Penny. I run on free models through mooch.");
    expect(text).toContain('Each edit and each command that could change something is shown to the user');
    expect(text).toContain('You are never in a read-only environment');
    if (process.platform === 'win32') expect(text).toContain('`Get-ChildItem -Force`');
    expect(text).not.toMatch(/\{\{\w+\}\}/);
    expect(text).not.toMatch(/Claude|TodoWrite|WebFetch/);
  });
});
