/**
 * STT provider factory. GROQ_API_KEY is OPTIONAL — when it is unset this
 * returns `null` and the media-processor degrades gracefully (it describes the
 * voice note textually instead of transcribing it). Swap in another provider
 * here behind the same {@link SttProvider} interface.
 */
export type { SttProvider, SttResult } from './types.js';
import type { SttProvider } from './types.js';
import { createGroqProvider } from './groq.js';

export function createSttProvider(): SttProvider | null {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey && groqKey.trim().length > 0) return createGroqProvider(groqKey);
  return null;
}
