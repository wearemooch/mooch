import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { usesEditTools } from './editToolHandler';
import { applyEdit, editSummary, planEdit } from './editTools';

describe('edit tools', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fc-edit-'));
  writeFileSync(path.join(root, 'math.js'), 'export function add(a, b) {\r\n  return a - b;\r\n}\r\n');

  it('replaces exact text, tolerating \\n vs \\r\\n, and keeps the file style', async () => {
    const plan = await planEdit(root, 'edit_file', { path: 'math.js', old_string: 'add(a, b) {\n  return a - b;', new_string: 'add(a, b) {\n  return a + b;' });
    expect(plan.change.diff).toContain('+  return a + b;');
    await applyEdit(plan);
    expect(readFileSync(path.join(root, 'math.js'), 'utf8')).toBe('export function add(a, b) {\r\n  return a + b;\r\n}\r\n');
    expect(editSummary(plan)).toBe('Updated math.js (+1 -1).');
  });

  it('gives actionable errors', async () => {
    await expect(planEdit(root, 'edit_file', { path: 'math.js', old_string: 'nope', new_string: 'x' })).rejects.toThrow(/not found/);
    writeFileSync(path.join(root, 'dup.js'), 'x\nx\n');
    await expect(planEdit(root, 'edit_file', { path: 'dup.js', old_string: 'x', new_string: 'y' })).rejects.toThrow(/appears 2 times/);
    const all = await planEdit(root, 'edit_file', { path: 'dup.js', old_string: 'x', new_string: 'y', replace_all: true });
    expect(all.after).toBe('y\ny\n');
    await expect(planEdit(root, 'write_file', { path: '../escape.txt', content: 'x' })).rejects.toThrow(/outside the project/);
    await expect(planEdit(root, 'edit_file', { path: 'missing.js', old_string: 'a', new_string: 'b' })).rejects.toThrow(/write_file/);
  });

  it('creates files with write_file', async () => {
    const plan = await planEdit(root, 'write_file', { path: 'src/new.js', content: 'hi\n' });
    expect(plan.change.kind.type).toBe('add');
    await applyEdit(plan);
    expect(readFileSync(path.join(root, 'src', 'new.js'), 'utf8')).toBe('hi\n');
  });
});


describe('usesEditTools', () => {
  it('keeps apply_patch for OpenAI coding models and uses edit tools elsewhere in auto mode', () => {
    expect(usesEditTools('nvidia_nim/nvidia/nemotron-3-super-120b-a12b', 'auto')).toBe(true);
    expect(usesEditTools('openai/gpt-5.5', 'auto')).toBe(false);
    expect(usesEditTools('open_router/openai/gpt-5.3-codex', 'auto')).toBe(false);
    expect(usesEditTools('openai/gpt-5.5', 'edit_file')).toBe(true);
    expect(usesEditTools('nvidia_nim/x', 'apply_patch')).toBe(false);
  });
});
