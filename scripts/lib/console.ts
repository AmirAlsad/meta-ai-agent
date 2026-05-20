/**
 * Interactive console helpers shared by setup / capture scripts.
 *
 * Two surfaces:
 *  1. Status helpers — `info`, `success`, `warn`, `fail`, `step`, `divider` —
 *     ANSI-colored when stdout is a TTY, plain text otherwise. CI / piped
 *     output stays readable.
 *  2. Interactive prompts — `ask`, `confirm`, `pause`, `waitFor` — built on
 *     Node's `readline/promises`. Avoid pulling in a dialog framework (inquirer
 *     etc.) to keep dev-deps lean.
 *
 * WHY no chalk: keep deps minimal. ANSI codes are stable and trivially
 * conditional on `process.stdout.isTTY`.
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/* ────────────────────────────────────────────────────────────────────────── */
/* ANSI color codes                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  blue: '[34m',
  cyan: '[36m',
  green: '[32m',
  yellow: '[33m',
  red: '[31m',
  magenta: '[35m'
} as const;

function isTTY(): boolean {
  return output.isTTY === true;
}

function colorize(code: string, text: string): string {
  if (!isTTY()) return text;
  return `${code}${text}${ANSI.reset}`;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Status print helpers                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/** Informational message (blue). */
export function info(msg: string): void {
  output.write(`${colorize(ANSI.blue, 'info')}  ${msg}\n`);
}

/** Success message (green). */
export function success(msg: string): void {
  output.write(`${colorize(ANSI.green, '✓')}     ${msg}\n`);
}

/** Warning message (yellow). */
export function warn(msg: string): void {
  output.write(`${colorize(ANSI.yellow, 'warn')}  ${msg}\n`);
}

/** Failure message (red). */
export function fail(msg: string): void {
  output.write(`${colorize(ANSI.red, '✗')}     ${msg}\n`);
}

/** Step counter (`[2/6] msg`). */
export function step(n: number, total: number, msg: string): void {
  const counter = colorize(ANSI.cyan, `[${n}/${total}]`);
  output.write(`${counter} ${colorize(ANSI.bold, msg)}\n`);
}

/** Section divider with optional centered title. */
export function divider(title?: string): void {
  const width = Math.min(80, output.columns ?? 80);
  if (!title) {
    output.write(`${colorize(ANSI.dim, '═'.repeat(width))}\n`);
    return;
  }
  const padded = ` ${title} `;
  const sideLen = Math.max(3, Math.floor((width - padded.length) / 2));
  const left = '═'.repeat(sideLen);
  const right = '═'.repeat(Math.max(3, width - sideLen - padded.length));
  output.write(`${colorize(ANSI.dim, left)}${colorize(ANSI.bold, padded)}${colorize(ANSI.dim, right)}\n`);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Interactive prompts                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Reading a line of input has two distinct cases:
 *
 *  - TTY: a human is at the keyboard. We want readline.Interface for line
 *    editing, history, and clean Ctrl-D handling. The interface stays open
 *    across prompts because the tty fd never EOFs unless the user presses
 *    Ctrl-D.
 *
 *  - Piped stdin: a producer (`printf "y\ny\n" | …`) has written some lines
 *    then closed the pipe. Node's `readline.Interface` auto-closes on the
 *    stdin `end` event — which fires as soon as the producer exits, often
 *    before the script reaches its second prompt. Once auto-closed,
 *    `rl.question()` throws `ERR_USE_AFTER_CLOSE`. This is the bug that
 *    silently turned every `confirm()` after the first into "default,
 *    swallowed in a catch".
 *
 *    The fix in the piped case is to bypass readline and consume the raw
 *    'data' stream into a line buffer ourselves. Lines that have already
 *    landed in the buffer remain readable indefinitely; only when both the
 *    buffer is empty AND stdin has ended do we report EOF.
 *
 * We pick the strategy lazily on first prompt (so unit tests that never
 * prompt pay nothing) and only one instance lives for the process.
 */
type LineReader = {
  readLine(prompt: string): Promise<string | null>;
  close(): void;
  isEof(): boolean;
};

let sharedReader: LineReader | undefined;
let signalHandlersAttached = false;

function makeReadlineReader(): LineReader {
  const rl = readline.createInterface({ input, output });
  let closed = false;
  rl.once('close', () => {
    closed = true;
  });
  return {
    async readLine(prompt: string): Promise<string | null> {
      if (closed) return null;
      try {
        return await rl.question(prompt);
      } catch (err) {
        // readline closes itself when the underlying input ends or is
        // destroyed. Surface that as a clean null rather than the cryptic
        // ERR_USE_AFTER_CLOSE.
        if ((err as NodeJS.ErrnoException)?.code === 'ERR_USE_AFTER_CLOSE') {
          closed = true;
          return null;
        }
        throw err;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        rl.close();
      } catch {
        /* no-op */
      }
    },
    isEof(): boolean {
      return closed;
    }
  };
}

function makeBufferedStdinReader(): LineReader {
  // Consume stdin as utf8 chunks and slice into newline-terminated lines.
  // Buffered lines survive past the stdin 'end' event so later prompts can
  // still consume them — this is the property that readline.Interface loses
  // when stdin EOFs.
  input.setEncoding('utf8');
  let buf = '';
  let ended = false;
  let closed = false;
  const pending: Array<(line: string | null) => void> = [];

  function drain(): void {
    while (pending.length > 0) {
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        // Strip optional trailing \r so CRLF-piped input behaves the same
        // as LF-piped input — matches what readline.question() returns.
        let line = buf.slice(0, nl);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buf = buf.slice(nl + 1);
        pending.shift()!(line);
        continue;
      }
      if (ended || closed) {
        // EOF: deliver any trailing partial line, then null for further
        // reads. A trailing partial line (no newline) is rare for our use
        // (printf "y" without \n) but we still return it.
        const tail = buf;
        buf = '';
        const resolver = pending.shift()!;
        resolver(tail.length > 0 ? tail : null);
        continue;
      }
      return;
    }
  }

  const onData = (chunk: string): void => {
    buf += chunk;
    drain();
  };
  const onEnd = (): void => {
    ended = true;
    drain();
  };
  input.on('data', onData);
  input.once('end', onEnd);

  return {
    async readLine(prompt: string): Promise<string | null> {
      if (closed) return null;
      if (prompt) output.write(prompt);
      return new Promise<string | null>((resolve) => {
        pending.push(resolve);
        drain();
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      input.off('data', onData);
      input.off('end', onEnd);
      // Resolve any in-flight readers with null so callers unblock.
      while (pending.length > 0) pending.shift()!(null);
    },
    isEof(): boolean {
      return closed || (ended && buf.length === 0);
    }
  };
}

function getLineReader(): LineReader {
  if (sharedReader === undefined) {
    // input.isTTY is the canonical Node signal for "stdin is a terminal".
    // When piped or redirected from a file, isTTY is undefined.
    sharedReader = input.isTTY ? makeReadlineReader() : makeBufferedStdinReader();
    ensureSignalHandlers();
  }
  return sharedReader;
}

/**
 * Cleanup hooks registered via {@link registerShutdown}. Run on SIGINT /
 * SIGTERM in parallel, awaited with a hard timeout so a stuck close()
 * doesn't hang the script.
 *
 * WHY a registry instead of each script installing its own
 * `process.once('SIGINT', ...)`: previously the readline SIGINT handler
 * here raced with the per-script handler in `verify-shared.ts` —
 * `console.ts` called `process.exit(130)` synchronously while the verify
 * handler was still awaiting `capture.close()`. The single-registry pattern
 * gives the harness one ordered shutdown path.
 */
const shutdownHooks = new Set<() => Promise<void> | void>();
const SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * Install SIGINT / SIGTERM handlers (idempotent). The handler closes the
 * line reader (so any blocked prompt unblocks) and then runs all registered
 * cleanup hooks in parallel with a {@link SHUTDOWN_TIMEOUT_MS} cap. We do
 * NOT call `process.exit` — instead we set `process.exitCode = 130` (POSIX
 * SIGINT) and let the event loop drain naturally once async cleanups
 * resolve. This avoids racing with script-level cleanup that may still be
 * holding handles (capture server, tunnel, etc.).
 */
function ensureSignalHandlers(): void {
  if (signalHandlersAttached) return;
  signalHandlersAttached = true;

  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => async (): Promise<void> => {
    // Close the line reader so any blocked prompt unblocks and the script's
    // `await` proceeds (the reader resolves pending reads with null).
    try {
      sharedReader?.close();
    } catch {
      /* no-op */
    }
    sharedReader = undefined;

    // Run registered hooks in parallel with a hard timeout. A stuck hook
    // (e.g. an ngrok tunnel that refuses to close) must not block exit.
    const hookPromises = Array.from(shutdownHooks).map(async (hook) => {
      try {
        await hook();
      } catch {
        /* hook errors are swallowed — we're shutting down anyway */
      }
    });
    const timeoutPromise = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      t.unref();
    });
    await Promise.race([Promise.all(hookPromises), timeoutPromise]);

    // Set the conventional exit code if nothing else already claimed it
    // (e.g. an earlier `process.exitCode = 1` from a script-level error).
    // SIGINT → 130, SIGTERM → 143. We don't call `process.exit` — the
    // event loop drains naturally once all hooks have resolved.
    if (process.exitCode === undefined || process.exitCode === 0) {
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
    }
  };

  process.once('SIGINT', () => {
    void onSignal('SIGINT')();
  });
  process.once('SIGTERM', () => {
    void onSignal('SIGTERM')();
  });
}

/**
 * Register a cleanup function to run on SIGINT / SIGTERM. Returns an
 * unregister fn so callers can detach a hook (e.g. when a long-lived
 * capture server is closed manually before the signal fires).
 *
 * Hooks run in parallel with a 5-second total budget. Long-running cleanups
 * should still complete inside that budget; if they can't, structure the
 * cleanup to be safe to interrupt (kill TCP sockets, etc.).
 */
export function registerShutdown(fn: () => Promise<void> | void): () => void {
  shutdownHooks.add(fn);
  ensureSignalHandlers();
  return () => {
    shutdownHooks.delete(fn);
  };
}

/**
 * Close the shared line reader. Call from script `finally` blocks to avoid
 * hanging the process on a still-open stdin listener.
 */
export function closePrompts(): void {
  if (sharedReader !== undefined) {
    try {
      sharedReader.close();
    } catch {
      /* no-op */
    }
    sharedReader = undefined;
  }
}

/**
 * Prompt for a free-form string. `defaultAnswer` is shown in `[brackets]`
 * and returned if the user just hits Enter, or if stdin is exhausted (in
 * which case we also warn so the developer notices).
 */
export async function ask(question: string, defaultAnswer?: string): Promise<string> {
  const reader = getLineReader();
  const prompt = defaultAnswer !== undefined ? `${question} [${defaultAnswer}] ` : `${question} `;
  const answer = await reader.readLine(prompt);
  if (answer === null) {
    if (defaultAnswer !== undefined) {
      warn(`ask("${question}"): stdin exhausted; using default "${defaultAnswer}".`);
      return defaultAnswer;
    }
    return '';
  }
  const trimmed = answer.trim();
  if (trimmed === '' && defaultAnswer !== undefined) return defaultAnswer;
  return trimmed;
}

/**
 * Yes / no prompt. Accepts y / yes / n / no (case-insensitive). Empty
 * response uses `defaultYes`. If stdin is exhausted (piped producer
 * finished and no buffered lines remain), we warn and return `defaultYes`
 * once — we do not loop forever asking a closed pipe.
 */
export async function confirm(question: string, defaultYes: boolean = true): Promise<boolean> {
  const reader = getLineReader();
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  for (;;) {
    const raw = await reader.readLine(`${question} ${suffix} `);
    if (raw === null) {
      // Truly out of input — buffered lines are gone AND stdin has ended.
      // Surface this loudly so a developer watching logs sees the
      // distinction between "user hit Enter" and "no input source".
      warn(
        `confirm("${question}"): stdin exhausted; falling back to default ` +
          `(${defaultYes ? 'YES' : 'NO'}). Run interactively to answer.`
      );
      return defaultYes;
    }
    const answer = raw.trim().toLowerCase();
    if (answer === '') return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    output.write('Please answer y or n.\n');
  }
}

/** Block until the user hits Enter (or stdin EOFs). */
export async function pause(msg: string = 'Press Enter to continue...'): Promise<void> {
  const reader = getLineReader();
  await reader.readLine(`${msg} `);
}

export interface WaitForOptions {
  /** Poll interval. Default 500ms. */
  intervalMs?: number;
  /** Hard timeout. Default 5 minutes. */
  timeoutMs?: number;
}

/**
 * Spin a dot animation in the console while `poller` returns `undefined`.
 * Returns the first non-`undefined` value from `poller`, or throws on
 * timeout.
 *
 * Used by the verify scripts: "Now send a message" → poll the capture
 * server's in-memory buffer until a matching webhook arrives.
 */
export async function waitFor<T>(
  description: string,
  poller: () => Promise<T | undefined>,
  opts: WaitForOptions = {}
): Promise<T> {
  const interval = opts.intervalMs ?? 500;
  const timeout = opts.timeoutMs ?? 5 * 60 * 1000;
  const deadline = Date.now() + timeout;

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  let spinnerTimer: NodeJS.Timeout | undefined;
  // Only show the spinner on a TTY; piped output prints a single static line
  // so logs stay tidy. .unref() so the timer doesn't pin the event loop.
  if (isTTY()) {
    spinnerTimer = setInterval(() => {
      const f = spinnerFrames[frame % spinnerFrames.length];
      output.write(`\r${colorize(ANSI.cyan, f ?? '?')} ${description}…  `);
      frame += 1;
    }, 100);
    spinnerTimer.unref();
  } else {
    output.write(`Waiting: ${description}…\n`);
  }

  try {
    while (Date.now() < deadline) {
      const result = await poller();
      if (result !== undefined) {
        // Clear the spinner line cleanly before returning so the caller's
        // next log line starts at column 0.
        if (isTTY()) output.write('\r' + ' '.repeat((description.length ?? 0) + 8) + '\r');
        return result;
      }
      await sleep(interval);
    }
    throw new Error(`Timed out after ${timeout}ms waiting: ${description}`);
  } finally {
    if (spinnerTimer) clearInterval(spinnerTimer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Unref so a pending sleep doesn't keep the process alive when the
    // caller catches a timeout and exits.
    t.unref();
  });
}
