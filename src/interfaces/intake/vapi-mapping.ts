/**
 * THE one place that knows what a raw Vapi payload looks like.
 *
 * The raw schema is not final, so this file is deliberately tolerant: it reads
 * a handful of known paths, accepts the alternatives Vapi uses depending on
 * where the call came from, and ignores everything else. Nothing outside this
 * file may reference a Vapi field name.
 *
 * When the payload changes, this file changes — and nothing else.
 */

import { z } from 'zod';

import type { IncomingCallEvent } from '../../core/types.js';

/** Vapi message type that ends a call. Everything else is acknowledged and dropped. */
export const END_OF_CALL_TYPE = 'end-of-call-report';

const phoneNumberSchema = z.object({ number: z.string().optional() }).optional();

const customerSchema = z
  .object({
    number: z.string().optional(),
    name: z.string().optional(),
  })
  .optional();

/**
 * Only the fields we actually consume are declared. Unknown keys are dropped
 * rather than rejected: a strict schema would discard whole calls whenever Vapi
 * adds a field, and a discarded call is exactly the lost order we exist to
 * prevent.
 */
const vapiWebhookSchema = z.object({
  message: z.object({
    type: z.string().optional(),
    endedReason: z.string().optional(),
    startedAt: z.union([z.string(), z.number()]).optional(),
    endedAt: z.union([z.string(), z.number()]).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    customer: customerSchema,
    phoneNumber: phoneNumberSchema,
    call: z
      .object({
        id: z.string().optional(),
        startedAt: z.union([z.string(), z.number()]).optional(),
        endedAt: z.union([z.string(), z.number()]).optional(),
        customer: customerSchema,
        phoneNumber: phoneNumberSchema,
      })
      .optional(),
    analysis: z
      .object({
        // Kept as unknown: partial order data is stored raw, never interpreted.
        structuredData: z.unknown().optional(),
        successEvaluation: z.unknown().optional(),
      })
      .optional(),
  }),
});

export type VapiMappingResult =
  | { status: 'mapped'; event: IncomingCallEvent }
  /** A message type we do not act on (status-update, transcript, …). */
  | { status: 'ignored'; messageType: string }
  /** Right message type, but unusable content. */
  | { status: 'invalid'; problems: string[] };

function toIsoString(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Did the agent close a complete order?
 *
 * Read from `analysis.structuredData.orderCompleted`, with the agent's
 * successEvaluation as a fallback. The default is `false` on purpose: an
 * unnecessary follow-up message costs a friendly WhatsApp, a missed one costs
 * the order. Named and exported so the heuristic can be tested and changed in
 * one place once the agent prompt is final.
 */
export function deriveOrderCompleted(analysis: unknown): boolean {
  const record = asRecord(analysis);
  if (!record) return false;

  const structured = asRecord(record['structuredData']);
  const explicit = structured?.['orderCompleted'];
  if (typeof explicit === 'boolean') return explicit;
  if (typeof explicit === 'string') return explicit.trim().toLowerCase() === 'true';

  const success = record['successEvaluation'];
  if (typeof success === 'boolean') return success;
  if (typeof success === 'string') return success.trim().toLowerCase() === 'true';

  return false;
}

/**
 * Keys inside structuredData that carry control information rather than order
 * content. They are read above and stripped here, because a structuredData of
 * `{ orderCompleted: false }` would otherwise count as "partial order data
 * present" and tell the customer their order is incomplete when the agent
 * captured nothing at all.
 */
const CONTROL_KEYS = new Set(['orderCompleted', 'callerName', 'customerName', 'name']);

export function extractPartialOrder(structuredData: unknown): unknown {
  const record = asRecord(structuredData);
  if (!record) return structuredData;

  const entries = Object.entries(record).filter(([key]) => !CONTROL_KEYS.has(key));
  return Object.fromEntries(entries);
}

function deriveCallerName(message: z.infer<typeof vapiWebhookSchema>['message']): string | undefined {
  const structured = asRecord(asRecord(message.analysis)?.['structuredData']);
  for (const key of ['callerName', 'customerName', 'name']) {
    const value = structured?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }

  const fromCustomer = message.customer?.name ?? message.call?.customer?.name;
  return fromCustomer?.trim() ? fromCustomer.trim() : undefined;
}

/** Maps a raw Vapi webhook body onto the internal event. */
export function mapVapiWebhook(payload: unknown): VapiMappingResult {
  const parsed = vapiWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      status: 'invalid',
      problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }

  const { message } = parsed.data;
  const messageType = message.type ?? 'unknown';
  if (messageType !== END_OF_CALL_TYPE) {
    return { status: 'ignored', messageType };
  }

  const callId = message.call?.id;
  const fromPhone = message.customer?.number ?? message.call?.customer?.number;
  const toPhone = message.phoneNumber?.number ?? message.call?.phoneNumber?.number;
  const endedAt = toIsoString(message.endedAt ?? message.call?.endedAt ?? message.timestamp);
  const startedAt = toIsoString(message.startedAt ?? message.call?.startedAt) ?? endedAt;

  const problems: string[] = [];
  if (!callId) problems.push('message.call.id fehlt');
  if (!fromPhone) problems.push('message.customer.number fehlt');
  if (!endedAt) problems.push('message.endedAt fehlt oder ist kein gültiger Zeitstempel');

  if (!callId || !fromPhone || !endedAt || !startedAt) {
    return { status: 'invalid', problems };
  }

  const callerName = deriveCallerName(message);
  const partialOrder =
    message.analysis?.structuredData === undefined
      ? undefined
      : extractPartialOrder(message.analysis.structuredData);

  return {
    status: 'mapped',
    event: {
      callId,
      fromPhone,
      toPhone: toPhone ?? '',
      startedAt,
      endedAt,
      endedReason: message.endedReason ?? 'unknown',
      orderCompleted: deriveOrderCompleted(message.analysis),
      ...(callerName ? { callerName } : {}),
      ...(partialOrder !== undefined ? { partialOrder } : {}),
    },
  };
}
