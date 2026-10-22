import { createHash } from 'node:crypto';
import { z } from 'zod';

// The body GHL sends when the form is submitted. The workflow's webhook action
// can send these as top-level JSON or inside "customData", so both are accepted.
// GHL renders blank merge fields as empty strings; those become undefined here.

const optionalText = z
  .union([z.string(), z.number()])
  .optional()
  .nullable()
  .transform((v) => {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    return s === '' ? undefined : s;
  });

// GHL ids are alphanumeric. They go into API URLs, so nothing else is accepted.
const ghlId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, 'not a valid GHL id');

export const LeadPayloadSchema = z.object({
  contact_id: ghlId,
  first_name: optionalText,
  last_name: optionalText,
  residence_state: optionalText,
  unit_state: optionalText,
  desired_territory_zip: optionalText,
  liquid_capital: optionalText,
  net_worth: optionalText,
  preferred_language: optionalText,
  about_you: optionalText,
});

export type LeadPayload = z.infer<typeof LeadPayloadSchema>;

const flatten = (body: unknown): Record<string, unknown> => {
  const raw = (body ?? {}) as Record<string, unknown>;
  const custom = (raw.customData ?? {}) as Record<string, unknown>;
  return { ...raw, ...custom };
};

export function parsePayload(body: unknown): LeadPayload {
  return LeadPayloadSchema.parse(flatten(body));
}

// Sent by a second GHL workflow when an opportunity changes status or owner,
// so the rep's seat can be given back or moved (see opportunity_changed).
export const OpportunityPayloadSchema = z.object({
  opportunity_id: ghlId,
  // Lets the seat be found when the opportunity id was never recorded
  contact_id: ghlId.optional().or(z.literal('').transform(() => undefined)),
  // GHL's UI and merge field say "Abandon"; the API says "abandoned". Both mean the same.
  status: z
    .string()
    .trim()
    .toLowerCase()
    .transform((s) => (s === 'abandon' ? 'abandoned' : s))
    .pipe(z.enum(['open', 'won', 'lost', 'abandoned'])),
  // GHL's opportunity merge fields expose the assigned user's id, not their
  // e-mail; either works, the id is looked up in the CRM's user list.
  assigned_to_email: optionalText,
  assigned_to_user_id: optionalText,
});

export type OpportunityPayload = z.infer<typeof OpportunityPayloadSchema>;

export function parseOpportunityPayload(body: unknown): OpportunityPayload {
  return OpportunityPayloadSchema.parse(flatten(body));
}

// Same contact + same answers on the same day = same event. GHL retries and
// double submits are recognized; the same answers sent again on a later day
// (a blocked lead coming back once a state is registered) are a new event.
// A retry that crosses midnight can't assign twice: a contact holds one seat.
export function eventKeyFor(payload: LeadPayload, now = new Date()): string {
  const { contact_id, ...answers } = payload;
  const canonical = JSON.stringify(answers, Object.keys(answers).sort());
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${contact_id}:${hash}:${now.toISOString().slice(0, 10)}`;
}
