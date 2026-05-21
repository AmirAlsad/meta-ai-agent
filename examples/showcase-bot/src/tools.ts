/**
 * Capability-gated tools the model can call. Each tool's `execute` PUSHES a Meta
 * `ChatAction` into a per-request collector and returns a short ack — the tools
 * are pure OUTPUT side-effects ("emit this reaction"), not transport calls. The
 * transport package performs the real send when it processes the returned
 * `actions[]`.
 *
 * Mirrors the parent sendblue showcase's `createCollector()` + `tool({
 * inputSchema, execute })` pattern, adapted to Meta's `ChatAction` field names
 * (`text`, `emoji`, `targetMessageId`).
 *
 * `send_message` is the normal way to reply: each call pushes one `message`
 * action, so calling it several times in a turn produces several chat bubbles
 * (deterministic, instead of guessing bubble boundaries from whitespace). The
 * plain-text fallback in llm.ts only fires when the model called NO outbound
 * tool at all.
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { ChatAction, ChannelFeature } from './contract.js';

export interface ActionCollector {
  actions: ChatAction[];
  silent: boolean;
}

export function createCollector(): ActionCollector {
  return { actions: [], silent: false };
}

/**
 * Quick local check for a media URL that Meta's servers definitely cannot fetch
 * (so it would fail with "Upload attachment failure" on send). Returns a short
 * human reason when the URL is unfetchable, or `undefined` when it looks OK.
 * This can't prove a URL IS fetchable (only Meta's server-side fetch can), but
 * it catches the common model mistakes — data:/localhost/non-https.
 */
export function unfetchableMediaUrlReason(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'that is not a valid URL.';
  }
  if (parsed.protocol === 'data:') {
    return 'a data: URL cannot be fetched by Meta (it needs a public HTTPS URL).';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `the URL scheme "${parsed.protocol}" is not fetchable by Meta (use https).`;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return "the URL points at localhost, which Meta's servers cannot reach.";
  }
  return undefined;
}

/**
 * Build the tool set for this turn, gated on the channel's capabilities. A tool
 * is only offered when the channel supports the underlying feature, so the model
 * never tries to react on a channel that can't react.
 *
 * The accumulator is typed `Record<string, Tool>`: a bare `Tool` defaults to
 * `Tool<any, any>`, which is exactly one of the members the AI SDK's internal
 * `ToolSet` index signature permits — so each concrete `tool({...})` assigns
 * cleanly while the whole map still satisfies `generateText`'s `tools` param.
 * (A `Tool<never, never>` annotation, by contrast, collapses input types and is
 * rejected.) Conditional spreads were avoided because a `{ x } | {}` union makes
 * the key optional, which the non-optional `ToolSet` index signature rejects.
 */
export function createActionTools(collector: ActionCollector, capabilities: ChannelFeature[]): Record<string, Tool> {
  const caps = new Set(capabilities);
  const tools: Record<string, Tool> = {};

  // Always available — a plain text reply is channel-independent. Calling this
  // multiple times in one turn sends a series of separate messages (bubbles).
  tools.send_message = tool({
    description:
      'Send a normal text reply to the customer. Use this for almost everything. ' +
      'You can call this MULTIPLE times in one turn to send a series of separate ' +
      'messages (one chat bubble each) — call it once per bubble.',
    inputSchema: z.object({
      text: z.string().min(1).describe('The message body. Keep it conversational, like a text message.')
    }),
    execute: async ({ text }) => {
      collector.actions.push({ type: 'message', text });
      return { ok: true };
    }
  });

  if (caps.has('reaction')) {
    tools.react_to_message = tool({
      description:
        "React to one of the customer's messages with a single emoji, as a lightweight " +
        'acknowledgement. Use the message id shown for that message. This does NOT send text — ' +
        'if the customer asked something, you must still answer in your normal text reply.',
      inputSchema: z.object({
        emoji: z.string().min(1).describe('A single emoji to react with, e.g. 👍 or ❤️.'),
        targetMessageId: z
          .string()
          .min(1)
          .describe('The id of the message to react to (the "message id" shown for that message).')
      }),
      execute: async ({ emoji, targetMessageId }) => {
        collector.actions.push({ type: 'reaction', emoji, targetMessageId });
        return { ok: true };
      }
    });
  }

  if (caps.has('reply_to')) {
    tools.reply_to_message = tool({
      description:
        'Send your text as a quoted reply threaded to a specific message, instead of a plain ' +
        'message. Use it when threading removes ambiguity — e.g. answering one of several ' +
        'questions the customer sent.',
      inputSchema: z.object({
        text: z.string().min(1).describe('The reply text to send.'),
        targetMessageId: z
          .string()
          .min(1)
          .describe('The id of the message to reply to (the "message id" shown for that message).')
      }),
      execute: async ({ text, targetMessageId }) => {
        collector.actions.push({ type: 'reply', text, targetMessageId });
        return { ok: true };
      }
    });
  }

  if (caps.has('media_send')) {
    tools.send_media = tool({
      description:
        'Send an image or document to the customer. Meta fetches the URL SERVER-SIDE at send ' +
        'time, so it MUST be a real, currently-public, directly-fetchable HTTPS URL pointing ' +
        'straight at the file — never a made-up URL, a webpage, a localhost/data: URL, or a ' +
        'customer inbound/expired media URL (all fail with "Upload attachment failure"). For a ' +
        'demo with no real asset, use a public placeholder like https://picsum.photos/seed/<word>/600. ' +
        'Set mimeType (e.g. image/jpeg) so the channel routes the kind correctly (especially Instagram). ' +
        'Optionally include a caption.',
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe(
            'Real, currently-public, directly-fetchable HTTPS URL of the media file. Meta fetches ' +
              'it server-side; data:/localhost/webpage/expired URLs fail.'
          ),
        caption: z.string().optional().describe('Optional text caption shown alongside the media.'),
        mimeType: z
          .string()
          .optional()
          .describe('MIME type of the media, e.g. image/jpeg or application/pdf. Strongly recommended.')
      }),
      execute: async ({ url, caption, mimeType }) => {
        // Meta fetches this URL server-side, so a non-public / data: / localhost URL is
        // GUARANTEED to fail with "Upload attachment failure". Reject it here (the tool
        // loop is multi-step, so the model sees this error and can retry with a real
        // public URL) rather than emitting an action the transport can only skip.
        const reason = unfetchableMediaUrlReason(url);
        if (reason) {
          return {
            ok: false,
            error:
              `Cannot send_media: ${reason} Provide a real, publicly-fetchable HTTPS URL ` +
              `(e.g. https://picsum.photos/seed/demo/600), or answer in text instead.`
          };
        }
        collector.actions.push({
          type: 'media',
          url,
          ...(caption ? { caption } : {}),
          ...(mimeType ? { mimeType } : {})
        });
        return { ok: true };
      }
    });
  }

  // Always available — silence is channel-independent.
  tools.stay_silent = tool({
    description:
      'Send absolutely nothing — no text, no reaction, no media. Use only when the inbound ' +
      'clearly does not need a response (e.g. an automated "thanks" you already reacted to). ' +
      'Do NOT call this if you have called react_to_message in the same turn — a reaction alone ' +
      'IS the response. Calling stay_silent cancels every other queued action.',
    inputSchema: z.object({
      reason: z.string().optional().describe('Optional internal note for logs; not sent to the customer.')
    }),
    execute: async ({ reason }) => {
      collector.silent = true;
      collector.actions = [];
      return { ok: true, reason: reason ?? null };
    }
  });

  return tools;
}
