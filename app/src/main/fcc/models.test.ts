import { describe, expect, it } from 'vitest';
import { configuredModel, FCC_DEFAULT_MODEL, isCodingModel, pickDefaultModel } from './models';
import { describeRetry, fccStartupSettled } from './sidecar';

describe('model selection', () => {
  it('hides classifiers, parsers and translators from the NIM catalog', () => {
    const hidden = [
      'nvidia_nim/meta/llama-guard-4-12b',
      'nvidia_nim/nvidia/llama-3.1-nemoguard-8b-content-safety',
      'nvidia_nim/nvidia/nemotron-3.5-content-safety',
      'nvidia_nim/nvidia/nemotron-parse-2.0',
      'nvidia_nim/nvidia/riva-translate-4b-instruct-v2',
      'nvidia_nim/nvidia/ising-calibration-1.5-31b',
      'nvidia_nim/google/diffusiongemma-26b-a4b-it',
    ];
    const shown = ['nvidia_nim/nvidia/nemotron-3-super-120b-a12b', 'nvidia_nim/openai/gpt-oss-20b', 'nvidia_nim/z-ai/glm-5.3', 'nvidia_nim/deepseek-ai/deepseek-v4.1-flash'];
    expect(hidden.filter(isCodingModel)).toEqual([]);
    expect(shown.filter(isCodingModel)).toEqual(shown);
  });

  it('prefers the configured MODEL, then FCC default, then the first model', () => {
    const models = [{ slug: 'a/x', displayName: 'x' }, { slug: FCC_DEFAULT_MODEL, displayName: 'n' }, { slug: 'b/y', displayName: 'y' }];
    expect(pickDefaultModel(models, 'b/y')).toBe('b/y');
    expect(pickDefaultModel(models, 'missing/z')).toBe(FCC_DEFAULT_MODEL);
    expect(pickDefaultModel(models.slice(2))).toBe('b/y');
    expect(configuredModel('FCC_CONFIG_SCHEMA=2\nMODEL="b/y"\n')).toBe('b/y');
    expect(configuredModel('FCC_CONFIG_SCHEMA=2\n')).toBeUndefined();
  });
});


describe('describeRetry', () => {
  it('turns FCC retry log lines into panel text', () => {
    expect(describeRetry('WARNING Provider transient error (APITimeoutError), attempt 2/5 failed; one provider recovery probe in 4.8s')).toBe(
      'The model timed out; retrying (attempt 3 of 5).',
    );
    expect(describeRetry('INFO GET /health 200')).toBeUndefined();
  });
});

describe('fccStartupSettled', () => {
  it('waits for providers and the catalog file', () => {
    expect(fccStartupSettled({ startup: { catalog_file: 'starting', providers: { nvidia_nim: 'starting' } } })).toBe(false);
    expect(fccStartupSettled({ startup: { catalog_file: 'ready', providers: { nvidia_nim: 'starting' } } })).toBe(false);
    expect(fccStartupSettled({ startup: { catalog_file: 'ready', providers: { nvidia_nim: 'ready', groq: 'failed' } } })).toBe(true);
    expect(fccStartupSettled({ startup: { catalog_file: 'ready', providers: {} } })).toBe(true);
    expect(fccStartupSettled({})).toBe(false);
  });
});
