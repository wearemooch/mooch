import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CouncilState } from '../../shared/ipc';
import { buildContext } from './context';
import { runCouncil } from './council';
import { formatDiffs, linesChanged, parseVerdict } from './review';
import { captureSnapshot, changesSince } from './turnSnapshot';

describe('review', () => {
  it('reads approve and changes verdicts', () => {
    expect(parseVerdict('VERDICT: APPROVE\nLooks right.')).toEqual({ verdict: 'approve', body: 'Looks right.' });
    expect(parseVerdict('**VERDICT: CHANGES**\n- `a.js:2`: off by one').verdict).toBe('changes');
    expect(parseVerdict('VERDICT: CHANGES\nnothing specific').verdict).toBe('approve');
    expect(parseVerdict('I think it is fine').verdict).toBe('unclear');
  });

  it('keeps the latest diff per file and counts changed lines', () => {
    const kind = { type: 'update', move_path: null } as const;
    const text = formatDiffs([
      { path: 'a.js', kind, diff: 'old' },
      { path: 'a.js', kind, diff: '@@\n-x\n+y' },
    ]);
    expect(text).toContain('+y');
    expect(text).not.toContain('old');
    expect(linesChanged('--- a\n+++ b\n@@\n-x\n+y\n+z\n ctx')).toBe(3);
  });
});

describe('council', () => {
  it('merges successful plans with the judge and survives a failed planner', async () => {
    const states: CouncilState[] = [];
    const asked: string[] = [];
    const merged = await runCouncil({
      request: 'fix it',
      planners: ['m1', 'm2', 'm3'],
      judge: 'j',
      plannerInstructions: 'plan',
      judgeInstructions: (plans) => `judge:${plans}`,
      emit: (s) => states.push(s),
      ask: async (model, instructions) => {
        asked.push(model);
        if (model === 'm2') throw new Error('timed out');
        return model === 'j' ? `merged from ${instructions.includes('Plan 2 (m3)') ? 'm1+m3' : '?'}` : `plan by ${model}`;
      },
    });
    expect(merged).toBe('merged from m1+m3');
    expect(states.at(-1)?.phase).toBe('done');
    expect(states.at(-1)?.planners.map((p) => p.status)).toEqual(['done', 'failed', 'done']);
  });

  it('merges without a straggler once two plans are in', async () => {
    const merged = await runCouncil({
      request: 'x', planners: ['a', 'b', 'slow'], judge: 'j', plannerInstructions: '', judgeInstructions: (plans) => plans, emit: () => {},
      stragglerGraceMs: 50,
      ask: async (model, instructions) => {
        if (model === 'slow') await new Promise((r) => setTimeout(r, 5000));
        return model === 'j' ? (instructions.includes('slow') ? 'bad' : 'merged a+b') : `plan ${model}`;
      },
    });
    expect(merged).toBe('merged a+b');
  });

  it('skips the judge when only one plan arrived', async () => {
    const merged = await runCouncil({
      request: 'x', planners: ['m1', 'm2'], judge: 'j', plannerInstructions: '', judgeInstructions: () => '', emit: () => {},
      ask: async (model) => {
        if (model !== 'm1') throw new Error('no');
        return 'only plan';
      },
    });
    expect(merged).toBe('only plan');
  });
});

describe('buildContext', () => {
  it('includes the tree, key files and open files within the budget', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fc-ctx-'));
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'node_modules'));
    writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
    writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;');
    const text = await buildContext(root, { openFiles: [path.join(root, 'src', 'a.js')] });
    expect(text).toContain('src/');
    expect(text).not.toContain('node_modules');
    expect(text).toContain('## package.json');
    expect(text).toContain('## src/a.js');
  });
});

describe('turn snapshots', () => {
  it('sees edits from any source, including new and deleted files', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fc-snap-'));
    writeFileSync(path.join(root, 'math.js'), 'return a - b;\n');
    writeFileSync(path.join(root, 'old.txt'), 'bye\n');
    const before = await captureSnapshot(root);
    writeFileSync(path.join(root, 'math.js'), 'return a + b;\n'); // e.g. written by Set-Content
    writeFileSync(path.join(root, 'new.txt'), 'hi\n');
    rmSync(path.join(root, 'old.txt'));
    const changes = await changesSince(root, before!);
    expect(changes.map((c) => [c.path, c.kind.type])).toEqual([['math.js', 'update'], ['new.txt', 'add'], ['old.txt', 'delete']]);
    expect(changes[0].diff).toContain('-return a - b;');
    expect(changes[0].diff).toContain('+return a + b;');
  });
});
