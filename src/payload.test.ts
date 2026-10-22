import { describe, expect, it } from 'vitest';
import { eventKeyFor, parseOpportunityPayload, parsePayload } from './payload.js';

describe('payloads', () => {
  it('reads the lead from the top level or customData, without keeping the secret', () => {
    const lead = parsePayload({ customData: { contact_id: 'abc123', unit_state: 'FL', webhook_secret: 's' } });
    expect(lead).toEqual(expect.objectContaining({ contact_id: 'abc123', unit_state: 'FL' }));
    expect(lead).not.toHaveProperty('webhook_secret');
  });

  it('rejects contact ids that are not plain GHL ids', () => {
    expect(() => parsePayload({ contact_id: '../locations/x' })).toThrow();
    expect(() => parsePayload({ contact_id: 'abc?x=1' })).toThrow();
    expect(() => parsePayload({ contact_id: '' })).toThrow();
  });

  it('reads opportunity changes', () => {
    expect(parseOpportunityPayload({ opportunity_id: 'opp1', status: 'Won', assigned_to_email: '' })).toEqual({
      opportunity_id: 'opp1',
      status: 'won',
      assigned_to_email: undefined,
      assigned_to_user_id: undefined,
    });
    expect(
      parseOpportunityPayload({ customData: { opportunity_id: 'opp1', status: 'open', assigned_to_user_id: 'u42' } }),
    ).toMatchObject({ assigned_to_user_id: 'u42' });
    expect(() => parseOpportunityPayload({ opportunity_id: 'opp1', status: 'archived' })).toThrow();
    // GHL's merge field renders the UI label "Abandon"
    expect(parseOpportunityPayload({ opportunity_id: 'opp1', status: 'Abandon' }).status).toBe('abandoned');
    expect(parseOpportunityPayload({ opportunity_id: 'opp1', status: 'abandoned' }).status).toBe('abandoned');
    expect(parseOpportunityPayload({ opportunity_id: 'opp1', status: 'won', contact_id: 'c9' }).contact_id).toBe('c9');
    expect(parseOpportunityPayload({ opportunity_id: 'opp1', status: 'won', contact_id: '' }).contact_id).toBeUndefined();
    expect(() => parseOpportunityPayload({ opportunity_id: 'opp1', status: 'won', contact_id: '../x' })).toThrow();
  });

  it('keys an event by contact, answers and day', () => {
    const lead = parsePayload({ contact_id: 'c1', unit_state: 'FL', net_worth: '1M' });
    const day = new Date('2026-10-22T10:00:00Z');
    expect(eventKeyFor(lead, day)).toBe(eventKeyFor(parsePayload({ net_worth: '1M', unit_state: 'FL', contact_id: 'c1' }), day));
    expect(eventKeyFor(lead, day)).toMatch(/^c1:[0-9a-f]{16}:2026-10-22$/);
    expect(eventKeyFor(lead, day)).not.toBe(eventKeyFor(parsePayload({ contact_id: 'c1', unit_state: 'FL', net_worth: '2M' }), day));
    expect(eventKeyFor(lead, day)).not.toBe(eventKeyFor(lead, new Date('2027-04-01T10:00:00Z')));
  });
});
