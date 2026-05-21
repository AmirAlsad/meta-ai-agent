/** Result of a successful transcription. */
export interface SttResult {
  text: string;
  language?: string;
  durationSeconds?: number;
}

/**
 * Speech-to-text provider abstraction. Mirrors the parent sendblue showcase's
 * provider shape so a different STT backend (Deepgram, OpenAI, etc.) can be
 * dropped in behind the same interface.
 */
export interface SttProvider {
  readonly name: string;
  transcribe(audio: Buffer, mimeType: string): Promise<SttResult>;
}
