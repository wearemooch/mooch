import { describe, expect, it } from 'vitest';
import { parseCommandFile } from '../main/slashCommands';
import { BUILT_INS, expandTemplate, findCommand, findModel, matchCommands, parseMode, parseSlash } from './slashCommands';

describe('slash commands', () => {
  it('parses only real commands at the start of the message', () => {
    expect(parseSlash('/model nemotron')).toEqual({ name: 'model', args: 'nemotron' });
    expect(parseSlash('  /New  ')).toEqual({ name: 'new', args: '' });
    expect(parseSlash('/race fix the\nflaky test')).toEqual({ name: 'race', args: 'fix the\nflaky test' });
    expect(parseSlash('/ hello')).toBeUndefined();
    expect(parseSlash('//not a command')).toBeUndefined();
    expect(parseSlash('please run /new')).toBeUndefined();
  });

  it('finds commands by name or alias and ranks menu matches', () => {
    expect(findCommand(BUILT_INS, 'clear')?.name).toBe('new');
    expect(findCommand(BUILT_INS, 'nope')).toBeUndefined();
    expect(matchCommands(BUILT_INS, 're').map((c) => c.name).slice(0, 3)).toEqual(['resume', 'rewind', 'review']);
    expect(matchCommands(BUILT_INS, 'context')[0].name).toBe('compact');
    expect(matchCommands(BUILT_INS, '')).toHaveLength(BUILT_INS.length);
  });

  it('expands templates', () => {
    expect(expandTemplate('Review $ARGUMENTS for bugs. Focus on $ARGUMENTS.', 'auth.ts')).toBe('Review auth.ts for bugs. Focus on auth.ts.');
    expect(expandTemplate('Write tests.', 'for utils')).toBe('Write tests.\n\nfor utils');
    expect(expandTemplate('Write tests.', '')).toBe('Write tests.');
  });

  it('reads modes and models loosely', () => {
    expect(parseMode('auto')).toBe('auto-edit');
    expect(parseMode('FULL')).toBe('full-auto');
    expect(parseMode('maybe')).toBeUndefined();
    const slugs = ['nvidia_nim/nvidia/nemotron-3-super-120b-a12b', 'nvidia_nim/z-ai/glm-5.3', 'groq/openai/gpt-oss-120b'];
    expect(findModel(slugs, 'glm')).toBe('nvidia_nim/z-ai/glm-5.3');
    expect(findModel(slugs, 'super')).toBe('nvidia_nim/nvidia/nemotron-3-super-120b-a12b');
    expect(findModel(slugs, 'claude')).toBeUndefined();
  });

  it('reads custom command files with or without frontmatter', () => {
    expect(parseCommandFile('---\ndescription: "Find bugs"\n---\nReview $ARGUMENTS\n')).toEqual({ description: 'Find bugs', body: 'Review $ARGUMENTS' });
    expect(parseCommandFile('Just a prompt\n')).toEqual({ description: '', body: 'Just a prompt' });
  });
});
