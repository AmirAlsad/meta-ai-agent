/**
 * Pure helpers for assembling WhatsApp template `components` arrays.
 *
 * WHY this module exists: {@link WhatsAppClient.sendTemplate} forwards a
 * caller-supplied `components: TemplateComponent[]` verbatim into the request
 * body — it does not know how to build that array. Constructing the
 * header/body/button shape Meta expects (with the right `type`, `sub_type`,
 * `index`, and per-parameter objects) by hand at every call site is error-prone,
 * so this module centralizes the mapping. The output of
 * {@link buildTemplateComponents} is exactly the `components` array accepted by
 * `WhatsAppClient.sendTemplate`.
 *
 * It is deliberately I/O-free and transport-agnostic (no `fetch`, no client) so
 * it can be unit-tested in isolation and reused by callers that assemble a
 * template message ahead of time.
 *
 * Faithful but not exhaustive: text parameters are the common case and have a
 * convenience builder ({@link textParameter}); currency / date_time / image /
 * document / video parameters are passed through untouched (their shapes are
 * already valid {@link TemplateParameter}s).
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
 */

import type { TemplateComponent, TemplateParameter } from '../shared/adapter.js';

/** A single button-component spec to expand into a `type: 'button'` component. */
export interface ButtonComponentInput {
  /** Which button kind this targets — maps to the component's `sub_type`. */
  subType: 'quick_reply' | 'url';
  /** 0-based button position within the template. */
  index: number;
  /** Substitution parameters for the button (e.g. a quick-reply payload). */
  parameters: TemplateParameter[];
}

export interface BuildTemplateComponentsInput {
  /** Header substitution params → a `type: 'header'` component. */
  headerParameters?: TemplateParameter[];
  /** Body `{{1}}`, `{{2}}` … params → a `type: 'body'` component. */
  bodyParameters?: TemplateParameter[];
  /** One entry per dynamic button → a `type: 'button'` component each. */
  buttonParameters?: ButtonComponentInput[];
}

/**
 * Build the `components` array for a WhatsApp template message from the supplied
 * header / body / button parameters. Sections are omitted when absent (header
 * and body) or when the list is empty (buttons), so passing `{}` yields `[]`.
 *
 * Order follows Meta's documented layout: header, then body, then buttons.
 *
 * BUTTON PARAMETER KIND IS THE CALLER'S RESPONSIBILITY — and it differs by
 * `sub_type`: a `quick_reply` button takes a `{type:'payload', payload}`
 * parameter (use {@link payloadParameter}), whereas a `url` button takes a
 * `{type:'text', text}` parameter (use {@link textParameter}). This builder does
 * NOT infer or coerce the parameter shape from `subType`; it forwards
 * `button.parameters` verbatim, so supply the matching kind per button or Meta
 * will reject the send.
 */
export function buildTemplateComponents(input: BuildTemplateComponentsInput): TemplateComponent[] {
  const components: TemplateComponent[] = [];

  // Header — emitted only when header params are supplied.
  if (input.headerParameters !== undefined) {
    components.push({ type: 'header', parameters: input.headerParameters });
  }

  // Body — emitted only when body params are supplied.
  if (input.bodyParameters !== undefined) {
    components.push({ type: 'body', parameters: input.bodyParameters });
  }

  // Buttons — one component per entry. WHY each carries `sub_type` + `index`:
  // Meta keys a dynamic button by its kind and 0-based position, unlike the
  // header/body components which are singletons.
  if (input.buttonParameters !== undefined) {
    for (const button of input.buttonParameters) {
      components.push({
        type: 'button',
        sub_type: button.subType,
        index: button.index,
        parameters: button.parameters
      });
    }
  }

  return components;
}

/**
 * Convenience: a plain `{ type: 'text', text }` template parameter. Use for body
 * / header substitutions and for a `url` BUTTON parameter (which carries text).
 */
export function textParameter(text: string): TemplateParameter {
  return { type: 'text', text };
}

/**
 * Convenience: a `{ type: 'payload', payload }` template parameter — the kind a
 * `quick_reply` BUTTON expects (its parameter carries a `payload`, not `text`).
 * See the button-parameter-kind note on {@link buildTemplateComponents}.
 */
export function payloadParameter(payload: string): TemplateParameter {
  return { type: 'payload', payload };
}
