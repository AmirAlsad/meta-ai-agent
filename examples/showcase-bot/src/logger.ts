/**
 * Tiny structured logger. One JSON object per line on stdout — enough to
 * follow turns, tool calls, media processing, and failures without pulling a
 * logging framework into this self-contained example. Mirrors the parent
 * transport's pino output shape loosely (level + message + structured data).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const entry = {
    at: new Date().toISOString(),
    level,
    source: 'showcase-bot',
    message,
    ...(data !== undefined && { data })
  };
  console.log(JSON.stringify(entry));
}
