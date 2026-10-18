// Second-model review: format the turn's changes for a reviewer and read its verdict.
import type { FileUpdateChange } from '../../shared/ipc';

export interface Verdict {
  verdict: 'approve' | 'changes' | 'unclear';
  body: string;
}

export function parseVerdict(text: string): Verdict {
  const match = /VERDICT:\s*\**\s*(APPROVE|CHANGES)/i.exec(text);
  const body = text.replace(/^.*VERDICT:[^\n]*\n?/is, '').trim();
  if (!match) return { verdict: 'unclear', body: text.trim() };
  if (match[1].toUpperCase() === 'APPROVE') return { verdict: 'approve', body };
  // A "changes" verdict with no actual items is treated as an approval.
  return /^\s*[-*\d]/m.test(body) ? { verdict: 'changes', body } : { verdict: 'approve', body };
}

/** All diffs from the turn, latest version per file, capped so the review stays one cheap call. */
export function formatDiffs(changes: FileUpdateChange[], maxChars = 30_000): string {
  const latest = new Map<string, FileUpdateChange>();
  for (const change of changes) latest.set(change.path, change);
  let out = '';
  for (const change of latest.values()) {
    const section = `### ${change.path} (${change.kind.type})\n\`\`\`diff\n${change.diff.trim()}\n\`\`\`\n\n`;
    if (out.length + section.length > maxChars) {
      out += `… ${latest.size} files changed; the rest were left out to keep the review short.\n`;
      break;
    }
    out += section;
  }
  return out.trim();
}

export function feedbackMessage(reviewer: string, body: string): string {
  return [
    `A second model (${reviewer}) reviewed your changes and asked for fixes:`,
    '',
    body,
    '',
    'Fix the issues you agree with and rerun the relevant tests. If you disagree with an item, say why in one line. Then give a short final summary.',
  ].join('\n');
}

export function linesChanged(diff: string): number {
  return diff.split('\n').filter((line) => /^[+-](?![+-]{2})/.test(line)).length;
}
