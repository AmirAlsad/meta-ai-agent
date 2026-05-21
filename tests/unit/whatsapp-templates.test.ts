import { describe, expect, it } from 'vitest';
import {
  buildTemplateComponents,
  payloadParameter,
  textParameter
} from '../../src/meta/whatsapp/templates.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* textParameter                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe('textParameter', () => {
  it('builds a { type: "text", text } parameter', () => {
    expect(textParameter('Ada')).toEqual({ type: 'text', text: 'Ada' });
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* payloadParameter                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

describe('payloadParameter', () => {
  it('builds a { type: "payload", payload } parameter (the quick_reply button kind)', () => {
    expect(payloadParameter('YES')).toEqual({ type: 'payload', payload: 'YES' });
  });

  it('produces a quick_reply button component carrying a payload parameter', () => {
    const components = buildTemplateComponents({
      buttonParameters: [{ subType: 'quick_reply', index: 0, parameters: [payloadParameter('CONFIRM')] }]
    });
    expect(components).toEqual([
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: 0,
        parameters: [{ type: 'payload', payload: 'CONFIRM' }]
      }
    ]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* buildTemplateComponents                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

describe('buildTemplateComponents', () => {
  it('returns [] for empty input', () => {
    expect(buildTemplateComponents({})).toEqual([]);
  });

  it('skips a button whose parameters array is empty (Meta rejects empty parameters)', () => {
    // An empty-parameters button (e.g. a quick_reply with no payload) would 400
    // at send time, same class as the header/body empty-array guard.
    expect(
      buildTemplateComponents({
        buttonParameters: [{ subType: 'quick_reply', index: 0, parameters: [] }]
      })
    ).toEqual([]);
    // A populated button alongside an empty one emits only the populated one.
    expect(
      buildTemplateComponents({
        buttonParameters: [
          { subType: 'quick_reply', index: 0, parameters: [] },
          { subType: 'quick_reply', index: 1, parameters: [payloadParameter('YES')] }
        ]
      })
    ).toEqual([
      { type: 'button', sub_type: 'quick_reply', index: 1, parameters: [{ type: 'payload', payload: 'YES' }] }
    ]);
  });

  it('builds header + body + button components in order with the exact shape', () => {
    const components = buildTemplateComponents({
      headerParameters: [textParameter('Header')],
      bodyParameters: [textParameter('Ada'), textParameter('Order #42')],
      buttonParameters: [
        { subType: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'YES' }] },
        { subType: 'url', index: 1, parameters: [textParameter('track-123')] }
      ]
    });

    expect(components).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: 'Header' }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Ada' },
          { type: 'text', text: 'Order #42' }
        ]
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: 0,
        parameters: [{ type: 'payload', payload: 'YES' }]
      },
      {
        type: 'button',
        sub_type: 'url',
        index: 1,
        parameters: [{ type: 'text', text: 'track-123' }]
      }
    ]);
  });

  it('omits the header when only body params are supplied', () => {
    const components = buildTemplateComponents({
      bodyParameters: [textParameter('Ada')]
    });
    expect(components).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Ada' }] }]);
  });

  it('omits the body when only header params are supplied', () => {
    const components = buildTemplateComponents({
      headerParameters: [textParameter('Hi')]
    });
    expect(components).toEqual([{ type: 'header', parameters: [{ type: 'text', text: 'Hi' }] }]);
  });

  it('emits one button component per entry and no header/body when only buttons given', () => {
    const components = buildTemplateComponents({
      buttonParameters: [
        { subType: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'A' }] }
      ]
    });
    expect(components).toEqual([
      { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'A' }] }
    ]);
  });

  it('passes non-text parameters (e.g. currency) through untouched', () => {
    const currency = {
      type: 'currency',
      currency: { fallback_value: '$10.00', code: 'USD', amount_1000: 10000 }
    };
    const components = buildTemplateComponents({ bodyParameters: [currency] });
    expect(components).toEqual([{ type: 'body', parameters: [currency] }]);
  });

  it('drops a section whose parameters array is empty (Meta rejects empty parameters)', () => {
    // An explicit empty list is treated as a clean no-op, NOT emitted: Meta
    // returns a 400 for a template component with an empty `parameters` array.
    expect(buildTemplateComponents({ bodyParameters: [] })).toEqual([]);
    expect(buildTemplateComponents({ headerParameters: [] })).toEqual([]);
    // A non-empty section alongside an empty one still emits only the non-empty.
    expect(
      buildTemplateComponents({ headerParameters: [], bodyParameters: [textParameter('hi')] })
    ).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'hi' }] }]);
  });
});
