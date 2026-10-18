// Readable names for gateway model ids like "nvidia_nim/nvidia/nemotron-3-super-120b-a12b".

const PROVIDERS: Record<string, string> = {
  nvidia_nim: 'NVIDIA NIM',
  groq: 'Groq',
  open_router: 'OpenRouter',
  gemini: 'Gemini',
  cerebras: 'Cerebras',
  mistral: 'Mistral',
  github_models: 'GitHub Models',
  cloudflare: 'Cloudflare',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/** "nvidia_nim/..." → "NVIDIA NIM". */
export function providerName(slug: string): string {
  const id = slug.split('/')[0] ?? slug;
  return PROVIDERS[id] ?? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "nvidia_nim/nvidia/nemotron-3-super-120b-a12b" → "nemotron-3-super-120b-a12b". */
export function shortModelName(slug: string): string {
  return slug.split('/').filter(Boolean).pop() ?? slug;
}

/** "nemotron-3-super-120b-a12b · NVIDIA NIM", for model pickers. */
export function modelLabel(slug: string): string {
  return slug.includes('/') ? `${shortModelName(slug)} · ${providerName(slug)}` : slug;
}

/** Models grouped by provider, in first-seen order, for <optgroup> pickers. */
export function groupByProvider<T extends { slug: string }>(models: T[]): { provider: string; models: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const provider = providerName(model.slug);
    groups.set(provider, [...(groups.get(provider) ?? []), model]);
  }
  return [...groups].map(([provider, list]) => ({ provider, models: list }));
}
