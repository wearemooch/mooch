import { describe, expect, it } from 'vitest';
import { buildCodexLaunch, FCC_TOKEN_ENV } from './launch';

describe('buildCodexLaunch', () => {
  const launch = buildCodexLaunch({
    codexBinary: 'codex.exe',
    fccUrl: 'http://127.0.0.1:5000/',
    fccToken: 'secret',
    modelCatalogPath: 'C:\\fcc\\.fcc\\codex-model-catalog.json',
    codexHome: 'C:\\codex-home',
    baseEnv: { PATH: 'p', OPENAI_API_KEY: 'k', OPENAI_PROJECT: 'x', CODEX_HOME: 'mine', HOME: 'h' },
  });

  it('routes the fcc provider to the local Responses endpoint', () => {
    expect(launch.args[0]).toBe('app-server');
    expect(launch.args).toContain('model_provider="fcc"');
    expect(launch.args).toContain('model_providers.fcc.base_url="http://127.0.0.1:5000/v1"');
    expect(launch.args).toContain('model_providers.fcc.wire_api="responses"');
    expect(launch.args).toContain(`model_providers.fcc.env_key="${FCC_TOKEN_ENV}"`);
  });

  it.runIf(process.platform === 'win32')('escapes Windows paths as TOML strings', () => {
    expect(launch.args).toContain('model_catalog_json="C:\\\\fcc\\\\.fcc\\\\codex-model-catalog.json"');
  });

  it('isolates Codex from the user environment', () => {
    expect(launch.env.OPENAI_API_KEY).toBeUndefined();
    expect(launch.env.OPENAI_PROJECT).toBeUndefined();
    expect(launch.env.CODEX_HOME).toBe('C:\\codex-home');
    expect(launch.env[FCC_TOKEN_ENV]).toBe('secret');
    expect(launch.env.PATH).toBe('p');
  });
});
