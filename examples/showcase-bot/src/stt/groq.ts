/**
 * Groq Whisper transcriber. Groq hosts OpenAI's Whisper models behind an
 * OpenAI-compatible audio-transcriptions endpoint and is fast + cheap, which is
 * why this example defaults to it. Requires GROQ_API_KEY.
 */
import Groq, { toFile } from 'groq-sdk';
import type { SttProvider, SttResult } from './types.js';

/** Whisper accepts a fixed set of container formats; map MIME → file extension. */
const MIME_TO_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  // WhatsApp voice notes are Opus-in-OGG; Messenger/IG audio is often mp4/aac.
  'audio/opus': 'ogg'
};

const PRIMARY_MODEL = 'whisper-large-v3-turbo';
const FALLBACK_MODEL = 'whisper-large-v3';

export function createGroqProvider(apiKey: string): SttProvider {
  const client = new Groq({ apiKey });

  return {
    name: 'groq',

    async transcribe(audio: Buffer, mimeType: string): Promise<SttResult> {
      const baseMime = mimeType.split(';')[0]!.trim();
      const ext = MIME_TO_EXT[baseMime] ?? 'ogg';
      const file = await toFile(audio, `audio.${ext}`);

      try {
        return await callWhisper(client, file, PRIMARY_MODEL);
      } catch (err) {
        // The turbo model is occasionally unavailable; fall back to the full
        // model on a model-routing error, but rethrow anything else.
        const msg = err instanceof Error ? err.message : String(err);
        const isModelError =
          msg.includes('model') ||
          msg.includes('404') ||
          msg.includes('not found') ||
          msg.includes('not available');
        if (!isModelError) throw err;

        try {
          return await callWhisper(client, file, FALLBACK_MODEL);
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          throw new Error(`Primary model failed: ${msg}; fallback model also failed: ${fallbackMsg}`);
        }
      }
    }
  };
}

interface VerboseTranscription {
  text: string;
  language?: string;
  duration?: number;
}

async function callWhisper(
  client: Groq,
  file: Awaited<ReturnType<typeof toFile>>,
  model: string
): Promise<SttResult> {
  const response = (await client.audio.transcriptions.create({
    file,
    model,
    response_format: 'verbose_json'
  })) as unknown as VerboseTranscription;

  return {
    text: response.text,
    language: response.language,
    durationSeconds: response.duration
  };
}
