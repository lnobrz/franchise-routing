import { describe, expect, it, vi } from 'vitest';
import { createRouter } from './router.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { GhlClient } from './ghl.js';
import type { Extractor } from './ai/extract.js';
import type { RepRow } from './types.js';

const ana: RepRow = {
  id: 'ana',
  full_name: 'Ana Rodriguez',
  email: 'ana.rodriguez@example.com',
  covered_states: ['FL'],
  languages: ['English', 'Spanish'],
  timezone: 'America/New_York',
  work_start: '00:00:00',
  work_end: '23:59:00',
  work_days: [1, 2, 3, 4, 5, 6, 7],
  max_open_leads: 8,
  open_leads: 2,
  is_active: true,
};

function setup(overrides: { claim?: boolean; reserve?: string | null; failOpportunity?: boolean } = {}) {
  const db = {
    claimEvent: vi.fn().mockResolvedValue(overrides.claim ?? true),
    unclaimEvent: vi.fn().mockResolvedValue(undefined),
    states: vi.fn().mockResolvedValue(
      new Map([
        ['FL', { code: 'FL', name: 'Florida', registration_status: 'not_required', registration_expires_at: null, total_slots: 10, sold_slots: 3 }],
      ]),
    ),
    zip: vi.fn().mockResolvedValue(null),
    territory: vi.fn().mockResolvedValue(null),
    reps: vi.fn().mockResolvedValue([ana]),
    reserveRep: vi.fn().mockResolvedValue(overrides.reserve === undefined ? 'ana' : overrides.reserve),
    releaseRep: vi.fn().mockResolvedValue(undefined),
    saveDecision: vi.fn().mockResolvedValue(undefined),
  } as unknown as Db & Record<string, ReturnType<typeof vi.fn>>;

  const ghl = {
    userIdsByEmail: vi.fn().mockResolvedValue(new Map([['ana.rodriguez@example.com', 'ghl-ana']])),
    pipeline: vi.fn().mockResolvedValue({ pipelineId: 'p1', firstStageId: 's1' }),
    assignContact: vi.fn().mockResolvedValue(undefined),
    addTags: vi.fn().mockResolvedValue(undefined),
    addNote: vi.fn().mockResolvedValue(undefined),
    createOpportunity: overrides.failOpportunity
      ? vi.fn().mockRejectedValue(new Error('GHL 500'))
      : vi.fn().mockResolvedValue('opp1'),
  } as unknown as GhlClient & Record<string, ReturnType<typeof vi.fn>>;

  const extractor: Extractor = { extract: vi.fn().mockResolvedValue(null) };
  const config = { AI_MIN_CONFIDENCE: 0.7, BUSINESS_TIMEZONE: 'America/New_York', GHL_PIPELINE_NAME: 'Demo' } as Config;

  return { db, ghl, route: createRouter({ db, ghl, extractor, config }) };
}

const lead = { contact_id: 'c1', first_name: 'Laura', residence_state: 'FL', unit_state: 'FL' };

describe('routeLead', () => {
  it('assigns, writes the CRM once and logs the decision', async () => {
    const { db, ghl, route } = setup();
    const result = await route(lead, 'c1:abc');

    expect(result).toMatchObject({ status: 'processed', outcome: 'assigned', rep: 'Ana Rodriguez' });
    expect(ghl.assignContact).toHaveBeenCalledWith('c1', 'ghl-ana');
    expect(ghl.createOpportunity).toHaveBeenCalledTimes(1);
    expect(db.saveDecision).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'assigned', rep_id: 'ana' }));
  });

  it('does nothing for an event it already processed', async () => {
    const { ghl, route } = setup({ claim: false });
    expect(await route(lead, 'c1:abc')).toEqual({ status: 'duplicate' });
    expect(ghl.assignContact).not.toHaveBeenCalled();
  });

  it('sends the lead to the manager queue when every rep is full', async () => {
    const { ghl, route } = setup({ reserve: null });
    const result = await route(lead, 'c1:abc');
    expect(result.outcome).toBe('needs_review');
    expect(ghl.addTags).toHaveBeenCalledWith('c1', ['routing:needs-review']);
    expect(ghl.createOpportunity).not.toHaveBeenCalled();
  });

  it('gives the seat back and frees the event when the CRM write fails', async () => {
    const { db, route } = setup({ failOpportunity: true });
    await expect(route(lead, 'c1:abc')).rejects.toThrow('GHL 500');
    expect(db.releaseRep).toHaveBeenCalledWith('ana');
    expect(db.unclaimEvent).toHaveBeenCalledWith('c1:abc');
  });
});
