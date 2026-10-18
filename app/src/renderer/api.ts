import type { FreeCodeApi } from '../shared/ipc';

declare global {
  interface Window {
    freeCode: FreeCodeApi;
  }
}

export const api = window.freeCode;

export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Electron prefixes errors thrown in ipcMain handlers.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
