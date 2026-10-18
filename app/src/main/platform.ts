// What differs between Windows, macOS and Linux: which agent-engine build to run, program names,
// and where the gateway's private Python runtime is installed.
import path from 'node:path';

export interface EngineTarget {
  /** The npm package that carries the engine for this OS and CPU. */
  pkg: string;
  /** The Rust target folder inside the package's vendor/ directory. */
  triple: string;
}

const ENGINE_TARGETS: Record<string, EngineTarget> = {
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
};

export function engineTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): EngineTarget {
  const target = ENGINE_TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`mooch does not support ${platform} on ${arch}.`);
  return target;
}

/** "codex" → "codex.exe" on Windows. */
export function exe(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/**
 * The gateway's Python and packages (~300 MB) are installed software, not settings. On Windows they go
 * under %LOCALAPPDATA%\Programs: some machines give new folders in AppData\Local and \Roaming an
 * AppContainer ACE that breaks uv's Python install. Elsewhere they go in ~/.mooch/runtime.
 */
export function runtimeFolder(moochHome: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, folderName = 'mooch'): string {
  if (platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'Programs', `${folderName}-runtime`);
  return path.join(moochHome, 'runtime');
}
