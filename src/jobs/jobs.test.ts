import { describe, expect, it, vi } from 'vitest';
import { releaseWaiting } from './releaseWaiting.js';
import { recoverStuck } from './recoverStuck.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { GhlClient } from '../ghl.js';
import type { StateRow } from '../types.js';

const config = { BUSINESS_TIMEZONE: 'America/New_York', STALE_EVENT_MINUTES: 10 } as Config;
const open = (code: string): StateRow => ({
  code,
  name: code,
  registration_status: 'not_required',
  registration_expires_at: null,
  total_slots: 5,
  sold_slots: 0,
});

const ghlMock = () =>
  ({
    removeTags: vi.fn().mockResolvedValue(undefined),
    addTags: vi.fn().mockResolvedValue(undefined),
    addNote: vi.fn().mockResolvedValue(undefined),
  }) as unknown as GhlClient & Record<string, ReturnType<typeof vi.fn>>;

describe('releaseWaiting', () => {
  const waiting = [
    { id: 'd1', event_key: 'c1:aaa', contact_id: 'c1', residence_state: 'NJ', unit_state: 'NY' },
    { id: 'd2', event_key: 'c2:bbb', contact_id: 'c2', residence_state: 'NJ', unit_state: 'NY' },
  ];
  const dbMock = (status: string | null = null) =>
    ({
      waitingDecisions: vi.fn().mockResolvedValue(waiting),
      states: vi.fn().mockResolvedValue(new Map([['NJ', open('NJ')], ['NY', open('NY')]])),
      eventPayload: vi.fn().mockImplementation(async (key: string) => ({ contact_id: key.split(':')[0] })),
      eventStatus: vi.fn().mockResolvedValue(status),
      resolveDecision: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Db & Record<string, ReturnType<typeof vi.fn>>;

  it('re-routes with a fixed key, so a repeated run cannot assign the lead twice', async () => {
    const db = dbMock();
    const routeLead = vi.fn().mockResolvedValue({ status: 'processed', outcome: 'assigned' });
    await releaseWaiting({ db, ghl: ghlMock(), config, routeLead });
    expect(routeLead).toHaveBeenCalledWith({ contact_id: 'c1' }, 'c1:aaa:released');
    expect(db.resolveDecision).toHaveBeenCalledWith('d1');
  });

  it('keeps going when one lead fails', async () => {
    const db = dbMock();
    const routeLead = vi
      .fn()
      .mockRejectedValueOnce(new Error('GHL down'))
      .mockResolvedValueOnce({ status: 'processed', outcome: 'assigned' });
    expect(await releaseWaiting({ db, ghl: ghlMock(), config, routeLead })).toBe(1);
    expect(db.resolveDecision).toHaveBeenCalledTimes(1);
    expect(db.resolveDecision).toHaveBeenCalledWith('d2');
  });

  it('only closes the old decision when an earlier run already routed the lead', async () => {
    const db = dbMock('done');
    const routeLead = vi.fn().mockResolvedValue({ status: 'duplicate' });
    expect(await releaseWaiting({ db, ghl: ghlMock(), config, routeLead })).toBe(2);
    expect(db.resolveDecision).toHaveBeenCalledWith('d1');
  });

  it('leaves the lead waiting while the earlier run is unfinished', async () => {
    const db = dbMock('processing');
    const routeLead = vi.fn().mockResolvedValue({ status: 'duplicate' });
    expect(await releaseWaiting({ db, ghl: ghlMock(), config, routeLead })).toBe(0);
    expect(db.resolveDecision).not.toHaveBeenCalled();
  });
});

describe('recoverStuck', () => {
  const dbMock = (events: { event_key: string; contact_id: string; status: string }[], hasDecision = false) =>
    ({
      staleEvents: vi.fn().mockResolvedValue(events.map((e) => ({ ...e, payload: { contact_id: e.contact_id } }))),
      hasDecision: vi.fn().mockResolvedValue(hasDecision),
      setEventStatus: vi.fn().mockResolvedValue(true),
    }) as unknown as Db & Record<string, ReturnType<typeof vi.fn>>;

  it('routes again an event that died before reaching the CRM', async () => {
    const db = dbMock([{ event_key: 'c1:aaa', contact_id: 'c1', status: 'processing' }]);
    const routeLead = vi.fn().mockResolvedValue({ status: 'processed', outcome: 'assigned' });
    await recoverStuck({ db, ghl: ghlMock(), config, routeLead });
    expect(routeLead).toHaveBeenCalledWith({ contact_id: 'c1' }, 'c1:aaa');
  });

  it('marks done an event whose decision was logged', async () => {
    const db = dbMock([{ event_key: 'c1:aaa', contact_id: 'c1', status: 'writing_crm' }], true);
    const ghl = ghlMock();
    const routeLead = vi.fn();
    await recoverStuck({ db, ghl, config, routeLead });
    expect(db.setEventStatus).toHaveBeenCalledWith('c1:aaa', 'done');
    expect(routeLead).not.toHaveBeenCalled();
    expect(ghl.addTags).not.toHaveBeenCalled();
  });

  it('never re-runs an event that died while writing the CRM, it tells a person', async () => {
    const db = dbMock([{ event_key: 'c1:aaa', contact_id: 'c1', status: 'writing_crm' }]);
    const ghl = ghlMock();
    const routeLead = vi.fn();
    await recoverStuck({ db, ghl, config, routeLead });
    expect(routeLead).not.toHaveBeenCalled();
    expect(db.setEventStatus).toHaveBeenCalledWith('c1:aaa', 'needs_attention', undefined);
    expect(ghl.addTags).toHaveBeenCalledWith('c1', ['routing:needs-attention']);
  });
});
