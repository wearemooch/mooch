// Where mooch keeps the user's things: one folder, ~/.mooch, on every OS. Electron's own data
// (Chromium caches, the single-instance lock) stays in the OS app-data folder; nothing in it is ours.
import { homedir } from 'node:os';
import path from 'node:path';

export interface MoochPaths {
  home: string;
  settings: string;
  /** The gateway's HOME: provider keys and model choices live in .fcc/.env under it. */
  gateway: string;
  /** CODEX_HOME for the agent engine: its rollouts, sqlite state and config.toml. */
  engine: string;
  /** mooch's own per-chat logs (what the transcript showed), for the session browser. */
  sessions: string;
  skills: string;
  commands: string;
  mcp: string;
  checkpoints: string;
  races: string;
  logs: string;
}

/** `~/.mooch`, or `MOOCH_HOME` when set (tests, portable setups). */
export function moochHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.MOOCH_HOME?.trim();
  return override ? path.resolve(override) : path.join(home, '.mooch');
}

export function moochPaths(home: string = moochHome()): MoochPaths {
  return {
    home,
    settings: path.join(home, 'settings.json'),
    gateway: path.join(home, 'gateway'),
    engine: path.join(home, 'engine'),
    sessions: path.join(home, 'sessions'),
    skills: path.join(home, 'skills'),
    commands: path.join(home, 'commands'),
    mcp: path.join(home, 'mcp.json'),
    checkpoints: path.join(home, 'checkpoints'),
    races: path.join(home, 'races'),
    logs: path.join(home, 'logs'),
  };
}
