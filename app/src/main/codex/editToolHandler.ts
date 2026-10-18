// Connects mooch's edit tools to a Codex thread: plan the edit, show it, get approval, write it.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent, ThreadItem } from '../../shared/ipc';
import type { ToolHandler } from './appServer';
import { applyEdit, EDIT_TOOL_NAMES, editSummary, planEdit } from './editTools';

const NATIVE_APPLY_PATCH_PROVIDERS = new Set(['openai', 'openai_api', 'azure_openai']);

export type EditToolPreference = 'auto' | 'apply_patch' | 'edit_file';

/** Whether a model gets mooch's edit tools instead of Codex's freeform apply_patch. */
export function usesEditTools(slug: string, preference: EditToolPreference): boolean {
  if (preference !== 'auto') return preference === 'edit_file';
  const provider = slug.split('/')[0];
  // OpenAI's own coding models are trained on apply_patch; everyone else gets the JSON tools.
  return !(NATIVE_APPLY_PATCH_PROVIDERS.has(provider) || /gpt-5|codex/i.test(slug));
}

/** Copies FCC's Codex catalog, removing apply_patch for models that use mooch's edit tools. */
export async function writeDerivedCatalog(source: string, destination: string, useEditTools: (slug: string) => boolean): Promise<string> {
  const catalog = JSON.parse(await readFile(source, 'utf8')) as { models: { slug: string; apply_patch_tool_type?: string | null }[] };
  for (const model of catalog.models) if (useEditTools(model.slug)) model.apply_patch_tool_type = null;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(catalog, null, 2), 'utf8');
  return path.resolve(destination);
}

function textResult(text: string, success: boolean) {
  return { contentItems: [{ type: 'inputText' as const, text }], success };
}

export function createEditToolHandler(root: string, emit: (event: AgentEvent) => void): ToolHandler {
  return async (call, approve) => {
    if (!EDIT_TOOL_NAMES.has(call.tool)) return textResult(`Unknown tool ${call.tool}.`, false);
    let plan;
    try {
      plan = await planEdit(root, call.tool, (call.arguments ?? {}) as Record<string, unknown>);
    } catch (error) {
      return textResult(`Edit failed: ${(error as Error).message}`, false);
    }
    const itemId = `edit-${call.callId}`;
    const item = (status: 'inProgress' | 'completed' | 'declined' | 'failed'): ThreadItem => ({ type: 'fileChange', id: itemId, changes: [plan.change], status });
    emit({ kind: 'item', phase: 'started', item: item('inProgress') });
    const approved = await approve({ type: 'fileChange', paths: [plan.absolute] }, { itemId, change: plan.change });
    if (!approved) {
      emit({ kind: 'item', phase: 'completed', item: item('declined') });
      return textResult('The edit was declined. Do not retry it the same way; ask the user if you are unsure.', false);
    }
    try {
      await applyEdit(plan);
    } catch (error) {
      emit({ kind: 'item', phase: 'completed', item: item('failed') });
      return textResult(`Edit failed: ${(error as Error).message}`, false);
    }
    emit({ kind: 'item', phase: 'completed', item: item('completed') });
    return textResult(editSummary(plan), true);
  };
}
