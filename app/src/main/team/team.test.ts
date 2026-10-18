import { describe, expect, it } from 'vitest';
import { pickModels, resolveTeam } from './team';

const m = (...slugs: string[]) => slugs.map((slug) => ({ slug, displayName: slug }));

describe('team picker', () => {
  const nimOnly = m('nvidia_nim/nvidia/nemotron-3-super-120b-a12b', 'nvidia_nim/openai/gpt-oss-20b', 'nvidia_nim/z-ai/glm-5.3', 'nvidia_nim/zzz/unknown');
  const mixed = [...nimOnly, ...m('groq/openai/gpt-oss-120b', 'gemini/models/gemini-3.1-flash-lite')];

  it('prefers another provider for the reviewer', () => {
    const team = resolveTeam(mixed, 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b');
    expect(team.reviewer).toBe('groq/openai/gpt-oss-120b');
    expect(team.planners).toEqual(['nvidia_nim/nvidia/nemotron-3-super-120b-a12b', 'groq/openai/gpt-oss-120b', 'gemini/models/gemini-3.1-flash-lite']);
    expect(team.singleProvider).toBe(false);
  });

  it('falls back to other models on a single provider', () => {
    const team = resolveTeam(nimOnly, 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b');
    expect(team.reviewer).toBe('nvidia_nim/openai/gpt-oss-20b');
    expect(team.singleProvider).toBe(true);
    expect(team.contestants).toEqual(['nvidia_nim/nvidia/nemotron-3-super-120b-a12b', 'nvidia_nim/openai/gpt-oss-20b']);
    expect(team.planners).toHaveLength(2);
  });

  it('never picks excluded models and honors valid overrides', () => {
    expect(pickModels(nimOnly, 5, ['nvidia_nim/openai/gpt-oss-20b'])).not.toContain('nvidia_nim/openai/gpt-oss-20b');
    const team = resolveTeam(nimOnly, nimOnly[0].slug, { reviewer: 'nvidia_nim/z-ai/glm-5.3', judge: 'missing/model' });
    expect(team.reviewer).toBe('nvidia_nim/z-ai/glm-5.3');
    expect(team.judge).toBe(nimOnly[0].slug);
  });
});
