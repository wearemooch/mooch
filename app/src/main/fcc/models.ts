// Which models in FCC's catalog are worth offering to a coding agent, and which one to preselect.
import type { ModelOption } from '../../shared/ipc';

/** FCC's built-in default (config/settings.py DEFAULT_MODEL), used when MODEL isn't set. */
export const FCC_DEFAULT_MODEL = 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b';

// Providers list everything they host: safety classifiers, OCR/parsers, translators, embeddings, speech.
// None of these can drive an agent loop, so they are hidden from the picker.
const NON_CHAT = /(guard|safety|content-safety|topic-control|nemoguard|parse|translate|calibration|diffusion|embed|rerank|whisper|asr|tts|ocr|reward)/i;

export function isCodingModel(slug: string): boolean {
  return !NON_CHAT.test(slug);
}

/** MODEL from FCC's managed .env, if the user set one in Model Config. */
export function configuredModel(envText: string): string | undefined {
  const value = /^MODEL=(.*)$/m.exec(envText)?.[1]?.trim().replace(/^["']|["']$/g, '');
  return value || undefined;
}

export function pickDefaultModel(models: ModelOption[], configured?: string): string {
  for (const candidate of [configured, FCC_DEFAULT_MODEL]) {
    if (candidate && models.some((m) => m.slug === candidate)) return candidate;
  }
  return models[0]?.slug ?? '';
}
