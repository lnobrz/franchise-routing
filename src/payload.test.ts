import { describe, expect, it } from 'vitest';
import { parseOpportunityPayload, parsePayload } from './payload.js';

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
  });
});
