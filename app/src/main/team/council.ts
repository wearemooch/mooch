// Plan council: several models plan in parallel, a judge merges their plans into one.
import { randomUUID } from 'node:crypto';
import type { CouncilState } from '../../shared/ipc';

export type AskModel = (model: string, instructions: string, input: string, timeoutMs: number, signal?: AbortSignal) => Promise<string>;

export interface CouncilOptions {
  request: string;
  planners: string[];
  judge: string;
  plannerInstructions: string;
  judgeInstructions: (plans: string) => string;
  ask: AskModel;
  emit: (state: CouncilState) => void;
  plannerTimeoutMs?: number;
  judgeTimeoutMs?: number;
  /** Once two plans are in, how long to wait for the rest before merging without them. */
  stragglerGraceMs?: number;
}

/** Returns the merged plan, or undefined if no planner produced one. */
export async function runCouncil(options: CouncilOptions): Promise<string | undefined> {
  const state: CouncilState = {
    id: randomUUID(),
    phase: 'planning',
    judge: options.judge,
    planners: options.planners.map((model) => ({ model, status: 'running' })),
  };
  const publish = () => options.emit(structuredClone(state));
  publish();

  let settledCount = 0;
  let doneCount = 0;
  let releaseQuorum!: () => void;
  const quorum = new Promise<void>((resolve) => (releaseQuorum = resolve));
  let graceTimer: NodeJS.Timeout | undefined;
  const controllers = options.planners.map(() => new AbortController());
  const all = Promise.all(
    options.planners.map(async (model, index) => {
      try {
        const plan = await options.ask(model, options.plannerInstructions, options.request, options.plannerTimeoutMs ?? 120_000, controllers[index].signal);
        if (state.phase !== 'planning') return; // arrived after we moved on
        state.planners[index].plan = plan;
        state.planners[index].status = 'done';
        doneCount++;
      } catch (error) {
        if (state.phase !== 'planning') return;
        state.planners[index].status = 'failed';
        state.planners[index].error = (error as Error).message;
      } finally {
        settledCount++;
      }
      if (doneCount === 2 && settledCount < options.planners.length && !graceTimer) {
        graceTimer = setTimeout(releaseQuorum, options.stragglerGraceMs ?? 20_000);
      }
      publish();
    }),
  );
  await Promise.race([all, quorum]);
  clearTimeout(graceTimer);
  state.planners.forEach((planner, index) => {
    if (planner.status !== 'running') return;
    // Free the provider slot for the agent instead of waiting out the timeout.
    controllers[index].abort();
    planner.status = 'failed';
    planner.error = 'too slow, merged without it';
  });

  const plans = state.planners.filter((p) => p.status === 'done' && p.plan);
  if (plans.length === 0) {
    state.phase = 'failed';
    state.error = 'No planner answered. Continuing without a plan.';
    publish();
    return undefined;
  }
  if (plans.length === 1) {
    state.phase = 'done';
    state.merged = plans[0].plan;
    publish();
    return state.merged;
  }

  state.phase = 'judging';
  publish();
  const numbered = plans.map((p, i) => `## Plan ${i + 1} (${p.model})\n\n${p.plan}`).join('\n\n');
  try {
    state.merged = await options.ask(options.judge, options.judgeInstructions(numbered), options.request, options.judgeTimeoutMs ?? 120_000);
  } catch (error) {
    // The judge is optional polish; fall back to the first plan rather than failing the message.
    state.merged = plans[0].plan;
    state.error = `The judge failed (${(error as Error).message}); using plan 1.`;
  }
  state.phase = 'done';
  publish();
  return state.merged;
}

export function withPlan(request: string, plan: string): string {
  return `${request}\n\n---\nPlan from the planning council. Follow it unless you find a step is wrong, and say so if you deviate:\n\n${plan}`;
}
