// Chooses which models play which role, preferring a different provider than the main agent's.
import type { ModelOption, ResolvedTeam, TeamSettings } from '../../shared/ipc';

export function providerOf(slug: string): string {
  return slug.split('/')[0] ?? slug;
}

// Rough preference for agentic coding among commonly free models; unknown models rank after these.
// The first two NIM entries answered in 2–7s in our 2026-10-16 probe; several others timed out.
const PREFERENCE: RegExp[] = [
  /nemotron-3-super/,
  /gpt-oss-120b/,
  /gemini-3(\.\d+)?-pro/,
  /kimi-k3|kimi-k2/,
  /gpt-oss-20b/,
  /deepseek-v4(?!.*flash)/,
  /glm-5(\.\d+)?$/,
  /gemini-3(\.\d+)?-flash/,
  /qwen3/,
  /devstral|codestral/,
  /step-5/,
];

function rank(slug: string): number {
  const index = PREFERENCE.findIndex((pattern) => pattern.test(slug));
  return index < 0 ? PREFERENCE.length : index;
}

/**
 * Picks `count` models, never one in `exclude`. It goes provider by provider so the picks are
 * spread across providers (taking each provider's best model), then fills up with the next-best models.
 */
export function pickModels(models: ModelOption[], count: number, exclude: string[] = []): string[] {
  const candidates = models
    .map((m) => m.slug)
    .filter((slug) => !exclude.includes(slug))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const usedProviders = new Set(exclude.map(providerOf));
  const picks: string[] = [];
  for (const preferNewProvider of [true, false]) {
    for (const slug of candidates) {
      if (picks.length >= count) return picks;
      if (picks.includes(slug)) continue;
      if (preferNewProvider && usedProviders.has(providerOf(slug))) continue;
      picks.push(slug);
      usedProviders.add(providerOf(slug));
    }
  }
  return picks;
}

export function resolveTeam(models: ModelOption[], executor: string, overrides: TeamSettings = {}): ResolvedTeam {
  const available = new Set(models.map((m) => m.slug));
  const valid = (slug?: string) => (slug && available.has(slug) ? slug : undefined);
  const validList = (slugs?: string[]) => (slugs ?? []).filter((s) => available.has(s));

  const providers = new Set(models.map((m) => providerOf(m.slug)));
  // FCC runs at most 2 requests at once per provider, so a third helper on the same provider would just queue.
  const helpers = providers.size < 2 ? 1 : 2;
  const reviewer = valid(overrides.reviewer) ?? pickModels(models, 1, [executor])[0];
  const backup = valid(overrides.backup) ?? pickModels(models, 1, [executor])[0];
  const planners = validList(overrides.planners).length ? validList(overrides.planners) : [executor, ...pickModels(models, helpers, [executor])];
  const contestants = validList(overrides.contestants).length
    ? validList(overrides.contestants)
    : [executor, ...pickModels(models, helpers, [executor])];
  const judge = valid(overrides.judge) ?? executor;
  return { executor, reviewer, backup, planners, judge, contestants, singleProvider: providers.size < 2 };
}
