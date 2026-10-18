import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from './settings';

describe('mergeSettings', () => {
  const base = { ...DEFAULT_SETTINGS, team: { reviewer: 'groq/x', planners: ['a', 'b'] } };

  it('replaces the team, so an empty team resets every role to auto', () => {
    expect(mergeSettings(base, { team: {} }).team).toEqual({});
    expect(mergeSettings(base, { review: false }).team).toEqual(base.team);
  });

  it('drops malformed values instead of storing them', () => {
    const next = mergeSettings(base, {
      review: 'yes', hedgeDelayMs: 1, editTool: 'rm -rf', raceTestCommand: 'npm test\ncurl evil', team: { reviewer: '<script>', judge: 'nvidia_nim/z-ai/glm-5.3' }, extra: 1,
    });
    expect(next.review).toBe(true);
    expect(next.hedgeDelayMs).toBe(2000);
    expect(next.editTool).toBe('auto');
    expect(next.raceTestCommand).toBeUndefined();
    expect(next.team).toEqual({ judge: 'nvidia_nim/z-ai/glm-5.3' });
    expect('extra' in next).toBe(false);
  });

  it('clears the race test command when it is emptied', () => {
    const withCommand = mergeSettings(base, { raceTestCommand: ' npm test ' });
    expect(withCommand.raceTestCommand).toBe('npm test');
    expect(mergeSettings(withCommand, { raceTestCommand: undefined }).raceTestCommand).toBeUndefined();
  });

  it('accepts only the offered auto-compaction limits', () => {
    expect(DEFAULT_SETTINGS.autoCompactTokens).toBe(64_000);
    expect(mergeSettings(base, { autoCompactTokens: 0 }).autoCompactTokens).toBe(0);
    expect(mergeSettings(base, { autoCompactTokens: 12 }).autoCompactTokens).toBe(base.autoCompactTokens);
  });

  it('accepts only known themes, defaulting to following the system', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system');
    expect(mergeSettings(base, { theme: 'receipt' }).theme).toBe('receipt');
    expect(mergeSettings(base, { theme: 'solarized' }).theme).toBe(base.theme);
    expect(mergeSettings(base, { theme: 42 }).theme).toBe(base.theme);
  });
});
