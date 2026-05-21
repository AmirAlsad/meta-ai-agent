/**
 * The LLM turn, via the Vercel AI SDK.
 *
 * `generateText({ ..., stopWhen: stepCountIs(maxSteps) })` gives the tool
 * round-trip FOR FREE: when the model calls a tool, the SDK runs its `execute`,
 * feeds the result back, and calls the model again — up to `maxSteps` steps — so
 * the model produces its real TEXT answer AFTER any side-effect tool calls. No
 * hand-rolled tool loop (the whole point of this rewrite vs. the raw-SDK
 * version). We append `result.response.messages` to a per-`conversationKey`
 * history Map so multi-turn conversations stay coherent and the tool-call /
 * tool-result pairs never desync.
 */
import {
  createProviderRegistry,
  generateText,
  stepCountIs,
  type ModelMessage,
  type TextPart,
  type ImagePart
} from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { BotConfig } from './config.js';
import type { ChatAction, ChatRequest, IncomingMessage } from './contract.js';
import { log } from './logger.js';
import { buildMediaContent } from './media-processor.js';
import { createActionTools, createCollector } from './tools.js';

// The model id in config is registry-prefixed (`anthropic:...` / `openai:...`),
// which `registry.languageModel(id)` resolves to the right provider.
const registry = createProviderRegistry({ anthropic, openai });

/**
 * Per-conversation message history, keyed by `conversationKey` (one record per
 * conversation — matches the transport's keying). In-memory, per-process, and
 * unbounded: fine for a demo, but a real deployment would use a store with
 * TTL/eviction (and likely server-side context compaction for long chats).
 */
const history = new Map<string, ModelMessage[]>();

export interface ChatTurnResult {
  actions: ChatAction[];
  silent: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
  };
  latencyMs: number;
}

export async function runTurn(config: BotConfig, req: ChatRequest): Promise<ChatTurnResult> {
  const channelHistory = history.get(req.conversationKey) ?? [];
  const collector = createCollector();
  const tools = createActionTools(collector, req.capabilities);

  const userContent = await buildUserContent(req);
  channelHistory.push({ role: 'user', content: userContent });

  // Prompt caching: on Anthropic, mark the (stable) system prompt ephemeral so
  // it is cached and re-read on subsequent turns. Volatile per-turn context goes
  // in the user turn, so the cached system prefix stays valid. Other providers
  // take the plain string.
  const isAnthropic = config.model.startsWith('anthropic:');
  const system = isAnthropic
    ? {
        role: 'system' as const,
        content: config.systemPrompt,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }
      }
    : config.systemPrompt;

  const startTime = performance.now();
  const result = await generateText({
    model: registry.languageModel(config.model as Parameters<typeof registry.languageModel>[0]),
    maxOutputTokens: config.maxTokens,
    system,
    messages: channelHistory,
    tools,
    // The tool round-trip, for free: keep stepping (model → tool → model) until
    // the step cap. After side-effect tool calls the model emits its text answer.
    stopWhen: stepCountIs(config.maxSteps),
    onStepFinish({ toolCalls }) {
      for (const tc of toolCalls) {
        log('debug', `tool call: ${tc.toolName}`, {
          conversationKey: req.conversationKey,
          input: tc.input as Record<string, unknown>
        });
      }
    }
  });
  const latencyMs = Math.round(performance.now() - startTime);

  // Persist the full assistant/tool turns so the tool-call/tool-result pairs
  // stay intact for the next turn (the AI SDK rejects a dangling tool call).
  channelHistory.push(...result.response.messages);
  history.set(req.conversationKey, channelHistory);

  // Multiple bubbles are produced DETERMINISTICALLY by the model calling
  // `send_message` once per bubble (each pushes a `message` action). The
  // final-assistant-text below is only a fallback for the case where the model
  // produced its reply as plain text and called NO outbound tool — then that
  // text becomes a single `message` bubble. The `alreadyHasOutbound` guard
  // prevents doubling up when a tool already delivered the reply.
  const finalText = result.text?.trim();
  const alreadyHasOutbound = collector.actions.some(
    a => a.type === 'message' || a.type === 'reply' || a.type === 'media'
  );
  if (finalText && !collector.silent && !alreadyHasOutbound) {
    collector.actions.push({ type: 'message', text: finalText });
  }

  return {
    actions: collector.actions,
    silent: collector.silent,
    usage: {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
      ...(result.usage.cachedInputTokens != null ? { cachedTokens: result.usage.cachedInputTokens } : {})
    },
    latencyMs
  };
}

/**
 * Render the inbound turn as the AI SDK user content. Plain-text turns become a
 * single string (a context header + one tagged line per message). Turns that
 * carry media become an array of parts (text + image parts) so images go to the
 * model multimodally and audio/PDF arrive as transcribed/extracted text.
 */
async function buildUserContent(req: ChatRequest): Promise<string | Array<TextPart | ImagePart>> {
  const contextHeader = formatContextHeader(req);
  const messages = req.messages ?? [];
  const hasMedia = messages.some(m => m.media);

  if (!hasMedia) {
    const lines = messages.length > 0 ? messages.map(describeTextInbound).filter(Boolean) : [];
    if (lines.length === 0) {
      const agg = (req.message ?? '').trim();
      lines.push(agg.length > 0 ? agg : '[the customer sent a message with no text content]');
    }
    return `${contextHeader}\n\n${lines.join('\n')}`.trim();
  }

  const parts: Array<TextPart | ImagePart> = [{ type: 'text', text: contextHeader }];
  for (const m of messages) {
    if (m.media) {
      parts.push({ type: 'text', text: `(message id: ${m.channelMessageId})` });
      // Thread the message `type` so the classifier can use it as the PRIMARY
      // signal — Messenger/IG attachments set `type: 'image'` but no MIME.
      const processed = await buildMediaContent({ ...m.media, caption: m.media.caption ?? m.text }, m.type);
      parts.push(...processed.content);
    } else {
      // Describe non-media inbounds the SAME way as the no-media text path so a
      // reaction/location/sticker (which has empty `text`) in a turn that ALSO
      // carries media is surfaced to the model instead of collapsing to '[no text]'.
      parts.push({ type: 'text', text: describeTextInbound(m) });
    }
  }
  return parts;
}

/** One tagged line for a text/non-media inbound message. */
function describeTextInbound(m: IncomingMessage): string {
  const text = (m.text ?? '').trim();
  if (text.length > 0) return `(message id: ${m.channelMessageId}) ${text}`;
  if (m.type === 'reaction') {
    const emoji = m.reaction?.emoji?.trim();
    return `(message id: ${m.channelMessageId}) [the customer reacted with ${emoji || 'an emoji'}]`;
  }
  return `(message id: ${m.channelMessageId}) [the customer sent a ${m.type} message]`;
}

/** Compact per-turn context line: channel, capabilities, window, known name. */
function formatContextHeader(req: ChatRequest): string {
  const caps = req.capabilities.length > 0 ? req.capabilities.join(', ') : 'none';
  const who = req.contact?.firstName ? ` The customer's first name is ${req.contact.firstName}.` : '';
  const window = req.context?.windowOpen === false ? ' The 24h reply window is CLOSED.' : '';
  return (
    `[context] channel=${req.channel}; channel capabilities: ${caps}.${who}${window} ` +
    'Only use a rich-action tool if it is in your tool list for this turn.'
  );
}

export function clearHistory(conversationKey?: string): void {
  if (conversationKey) history.delete(conversationKey);
  else history.clear();
}
