// User settings for the team features, stored as JSON in the app's data folder.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_DELAY_CHOICES, type FreeCodeSettings, type TeamSettings } from '../shared/ipc';
import { isThemeSetting } from '../shared/themes';

export const DEFAULT_SETTINGS: FreeCodeSettings = {
  review: true,
  deep: false,
  hedge: true,
  hedgeDelayMs: 10_000,
  editTool: 'auto',
  team: {},
  theme: 'system',
  // Free tiers often cap tokens per minute, and most free models do best well under their full window.
  autoCompactTokens: 64_000,
};

export const AUTO_COMPACT_CHOICES = [0, 32_000, 64_000, 128_000];

const EDIT_TOOLS: FreeCodeSettings['editTool'][] = ['auto', 'apply_patch', 'edit_file'];
const SLUG = /^[\w./:@-]{1,200}$/;

function slug(value: unknown): string | undefined {
  return typeof value === 'string' && SLUG.test(value) ? value : undefined;
}

function slugs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.map(slug).filter((s): s is string => !!s).slice(0, 5);
  return list.length ? list : undefined;
}

function cleanTeam(value: unknown): TeamSettings {
  const team = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out: TeamSettings = {
    reviewer: slug(team.reviewer),
    backup: slug(team.backup),
    judge: slug(team.judge),
    planners: slugs(team.planners),
    contestants: slugs(team.contestants),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as TeamSettings;
}

/**
 * Applies `patch` (from the window, or the file on disk) to `base`, keeping only well-formed values.
 * A `team` in the patch replaces the whole team, so "Reset to auto" ({}) really resets it.
 */
export function mergeSettings(base: FreeCodeSettings, patch: unknown): FreeCodeSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const next: FreeCodeSettings = { ...base, team: { ...base.team } };
  for (const key of ['review', 'deep', 'hedge'] as const) if (typeof p[key] === 'boolean') next[key] = p[key];
  if (typeof p.hedgeDelayMs === 'number' && Number.isFinite(p.hedgeDelayMs)) {
    // The nearest of the offered choices, so an older value (12s) lands on one the page can show.
    const wanted = p.hedgeDelayMs;
    next.hedgeDelayMs = BACKUP_DELAY_CHOICES.reduce((best, choice) => (Math.abs(choice - wanted) < Math.abs(best - wanted) ? choice : best));
  }
  if (EDIT_TOOLS.includes(p.editTool as FreeCodeSettings['editTool'])) next.editTool = p.editTool as FreeCodeSettings['editTool'];
  if ('raceTestCommand' in p) {
    const command = typeof p.raceTestCommand === 'string' ? p.raceTestCommand.trim().slice(0, 500) : '';
    if (command && !/[\r\n]/.test(command)) next.raceTestCommand = command;
    else delete next.raceTestCommand;
  }
  if ('team' in p) next.team = cleanTeam(p.team);
  if (isThemeSetting(p.theme)) next.theme = p.theme;
  if (AUTO_COMPACT_CHOICES.includes(p.autoCompactTokens as number)) next.autoCompactTokens = p.autoCompactTokens as number;
  return next;
}

export class SettingsStore {
  private current: FreeCodeSettings;

  constructor(private readonly file: string) {
    this.current = this.load();
  }

  get(): FreeCodeSettings {
    return this.current;
  }

  update(patch: unknown): FreeCodeSettings {
    this.current = mergeSettings(this.current, patch);
    mkdirSync(path.dirname(this.file), { recursive: true });
    // Write then rename, so a crash mid-write never leaves a half-written settings file.
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.current, null, 2), 'utf8');
    renameSync(temp, this.file);
    return this.current;
  }

  private load(): FreeCodeSettings {
    try {
      return mergeSettings({ ...DEFAULT_SETTINGS, team: {} }, JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return { ...DEFAULT_SETTINGS, team: {} };
    }
  }
}
