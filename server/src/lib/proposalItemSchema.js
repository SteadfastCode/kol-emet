/**
 * Validation for human-edited proposal payloads.
 *
 * An edited item is the highest-value training signal in the corpus — it is a
 * preference pair, proposed vs. what a person actually wanted — so it has to be
 * stored in exactly the same shape as `proposed`. A looser check here would let
 * an edit be saved in a shape the applier cannot write and the exporter cannot
 * read, and the damage would only surface much later.
 *
 * These schemas therefore mirror what the normalizer produces, and what
 * POST /entities would accept, rather than being a separate dialect.
 */

import { z } from 'zod';
import { BLOCK_TYPES } from '../models/Entity.js';
import { getCategories } from '../config/categories.js';

const blockSchema = z.object({
  type:  z.enum(BLOCK_TYPES),
  order: z.number(),
  data:  z.record(z.unknown()),
  _id:   z.any().optional(),
});

export function entityPayloadSchema(workspaceId) {
  return z.object({
    title:    z.string().min(1).max(200),
    // Validated against the live registry, not a frozen list, so this keeps
    // working when categories become user-defined in Phase 6.
    category: z.enum(getCategories(workspaceId)),
    summary:  z.string().max(400).optional().default(''),
    tags:     z.array(z.string()).max(24).optional().default([]),
    blocks:   z.array(blockSchema).optional().default([]),
    // Present on generated items; preserved through an edit so the record of
    // what the model originally said survives.
    normalizedCategory: z.string().optional(),
  }).strict();
}

const memberSchema = z.object({
  localKey: z.string().nullable().optional().default(null),
  refId:    z.string().nullable().optional().default(null),
  refModel: z.enum(['Entity', 'RelationshipGroup']).optional().default('Entity'),
  name:     z.string().min(1),
  label:    z.string().nullable().optional().default(null),
  notes:    z.string().nullable().optional().default(null),
}).refine(
  m => Boolean(m.localKey) !== Boolean(m.refId),
  { message: 'each member needs exactly one of localKey or refId' }
);

export const relationshipPayloadSchema = z.object({
  label:   z.string().nullable().optional().default(null),
  // Mirrors the <2-member rule the relationship routes already enforce, so an
  // edit cannot produce a group the applier would have to reject.
  members: z.array(memberSchema).min(2),
}).strict();

export const openQuestionPayloadSchema = z.object({
  question: z.string().min(1).max(1000),
  entry_ids: z.array(z.string()).optional().default([]),
}).strict();

/**
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateItemPayload(kind, payload, workspaceId) {
  const schema =
    kind === 'entity'        ? entityPayloadSchema(workspaceId) :
    kind === 'relationship'  ? relationshipPayloadSchema :
    kind === 'open_question' ? openQuestionPayloadSchema : null;

  if (!schema) return { ok: false, error: `Unknown item kind: ${kind}` };

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    return { ok: false, error: `${path}${issue?.message ?? 'invalid payload'}` };
  }
  return { ok: true, value: parsed.data };
}
