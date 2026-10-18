// Provider keys through the gateway's own settings API, so the app has its own Providers page.
// The gateway checks each key against the provider before saving it.
import type { ProviderInfo, ProviderSaveResult } from '../../shared/ipc';

interface ConfigField {
  key: string;
  type: string;
  value?: { revision?: string | null; entries?: { reference?: string }[] };
}

interface ProviderStatus {
  provider_id: string;
  display_name: string;
  website_url?: string;
  kind: string;
  status: string;
  label: string;
  settings_keys: string[];
}

interface AdminConfig {
  fields: ConfigField[];
  provider_status: ProviderStatus[];
}

interface ApplyResult {
  applied: boolean;
  errors?: string[];
  credential_checks?: { key: string; index: number; status: string; message: string }[];
  credential_row_errors?: { key: string; index: number; message: string }[];
  restart?: { required?: boolean; automatic?: boolean };
}

/** Providers whose models are free to start with; listed first. */
const FREE_FIRST = ['nvidia_nim', 'groq', 'gemini', 'open_router', 'cerebras', 'mistral', 'github_models', 'cloudflare'];

async function admin<T>(baseUrl: string, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Gateway settings request failed (${response.status}).`);
  return (await response.json()) as T;
}

function keyField(config: AdminConfig, provider: ProviderStatus): ConfigField | undefined {
  return provider.settings_keys.map((key) => config.fields.find((f) => f.key === key)).find((f) => f?.type === 'api_key_list');
}

export async function listProviders(baseUrl: string): Promise<ProviderInfo[]> {
  const config = await admin<AdminConfig>(baseUrl, '/admin/api/config');
  const rank = (id: string) => (FREE_FIRST.includes(id) ? FREE_FIRST.indexOf(id) : FREE_FIRST.length);
  return config.provider_status
    .filter((p) => p.kind === 'remote' && keyField(config, p))
    .map((p) => ({
      id: p.provider_id,
      name: p.display_name,
      website: p.website_url?.startsWith('https://') ? p.website_url : undefined,
      configured: p.status === 'configured',
      status: p.label,
      keyCount: keyField(config, p)?.value?.entries?.length ?? 0,
    }))
    .sort((a, b) => Number(b.configured) - Number(a.configured) || rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

/** Replaces the provider's keys with `apiKey`, or removes them all when `apiKey` is empty. */
export async function saveProviderKey(baseUrl: string, providerId: string, apiKey: string): Promise<ProviderSaveResult> {
  const config = await admin<AdminConfig>(baseUrl, '/admin/api/config');
  const provider = config.provider_status.find((p) => p.provider_id === providerId);
  const field = provider && keyField(config, provider);
  if (!field) return { ok: false, message: 'Unknown provider.' };
  const key = apiKey.trim();
  if (/\s/.test(key)) return { ok: false, message: 'An API key cannot contain spaces or line breaks.' };
  const values = { [field.key]: { revision: field.value?.revision ?? null, entries: key ? [{ value: key }] : [] } };
  const result = await admin<ApplyResult>(baseUrl, '/admin/api/config/apply', { method: 'POST', body: JSON.stringify({ values }) });
  const rejected = [...(result.credential_row_errors ?? []), ...(result.credential_checks ?? []).filter((c) => c.status === 'rejected')][0];
  if (!result.applied) return { ok: false, message: rejected?.message ?? result.errors?.join('; ') ?? 'The key was not saved.' };
  const unverified = result.credential_checks?.find((c) => c.status === 'unverified');
  return {
    ok: true,
    message: !key ? 'Key removed.' : unverified ? `Saved, but the key could not be checked: ${unverified.message}` : 'Key saved and checked.',
    restartRequired: !!result.restart?.required && !result.restart.automatic,
  };
}
