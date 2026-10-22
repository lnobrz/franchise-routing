import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Outcome, RepRow, StateRow, TerritoryRow, ZipRow } from './types.js';
import type { LeadPayload } from './payload.js';
import type { AiExtraction } from './ai/extract.js';

export type EventStatus = 'processing' | 'writing_crm' | 'done' | 'needs_attention';
export type StaleEvent = { event_key: string; contact_id: string; payload: LeadPayload; status: EventStatus };
export type SeatChange = 'released' | 'moved' | 'unchanged' | 'ignored';

export class Db {
  private sb: SupabaseClient;

  constructor(url: string, secretKey: string) {
    this.sb = createClient(url, secretKey, { auth: { persistSession: false } });
  }

  // --- Idempotency -------------------------------------------------------

  /**
   * Returns a claim id, or null when the event is already taken (GHL retry,
   * double submit). An event left in 'processing' for longer than staleMinutes
   * is claimed again (see claim_event in schema.sql).
   */
  async claimEvent(eventKey: string, contactId: string, payload: LeadPayload, staleMinutes: number): Promise<string | null> {
    const { data, error } = await this.sb.rpc('claim_event', {
      p_event_key: eventKey,
      p_contact_id: contactId,
      p_payload: payload,
      stale_seconds: staleMinutes * 60,
    });
    if (error) throw new Error(`claimEvent: ${error.message}`);
    return (data as string | null) ?? null;
  }

  /** Lets a failed event be retried by GHL, and gives back the seat it took. */
  async unclaimEvent(eventKey: string, claimId: string): Promise<void> {
    const { error } = await this.sb.rpc('unclaim_event', { p_event_key: eventKey, p_claim_id: claimId });
    if (error) throw new Error(`unclaimEvent: ${error.message}`);
  }

  /** False when claimId no longer owns the event. Without claimId it always applies. */
  async setEventStatus(eventKey: string, status: EventStatus, claimId?: string): Promise<boolean> {
    const { data, error } = await this.sb.rpc('set_event_status', {
      p_event_key: eventKey,
      p_status: status,
      p_claim_id: claimId ?? null,
    });
    if (error) throw new Error(`setEventStatus: ${error.message}`);
    return data === true;
  }

  async eventStatus(eventKey: string): Promise<EventStatus | null> {
    const { data, error } = await this.sb
      .from('processed_events')
      .select('status')
      .eq('event_key', eventKey)
      .maybeSingle();
    if (error) throw new Error(`eventStatus: ${error.message}`);
    return (data?.status as EventStatus) ?? null;
  }

  async eventPayload(eventKey: string): Promise<LeadPayload | null> {
    const { data, error } = await this.sb
      .from('processed_events')
      .select('payload')
      .eq('event_key', eventKey)
      .maybeSingle();
    if (error) throw new Error(`eventPayload: ${error.message}`);
    return (data?.payload as LeadPayload) ?? null;
  }

  /** Events still processing or writing the CRM after staleMinutes. */
  async staleEvents(staleMinutes: number): Promise<StaleEvent[]> {
    const before = new Date(Date.now() - staleMinutes * 60_000).toISOString();
    const { data, error } = await this.sb
      .from('processed_events')
      .select('event_key, contact_id, payload, status')
      .in('status', ['processing', 'writing_crm'])
      .lt('updated_at', before);
    if (error) throw new Error(`staleEvents: ${error.message}`);
    return (data ?? []) as StaleEvent[];
  }

  async hasDecision(eventKey: string): Promise<boolean> {
    const { count, error } = await this.sb
      .from('routing_decisions')
      .select('id', { count: 'exact', head: true })
      .eq('event_key', eventKey);
    if (error) throw new Error(`hasDecision: ${error.message}`);
    return (count ?? 0) > 0;
  }

  // --- Reference data ----------------------------------------------------

  async states(codes: string[]): Promise<Map<string, StateRow>> {
    const unique = [...new Set(codes.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const { data, error } = await this.sb.from('states').select('*').in('code', unique);
    if (error) throw new Error(`states: ${error.message}`);
    return new Map((data as StateRow[]).map((s) => [s.code, s]));
  }

  async zip(zip: string): Promise<ZipRow | null> {
    const { data, error } = await this.sb.from('zip_codes').select('*').eq('zip', zip).maybeSingle();
    if (error) throw new Error(`zip: ${error.message}`);
    return data as ZipRow | null;
  }

  async territory(code: string): Promise<TerritoryRow | null> {
    const { data, error } = await this.sb.from('territories').select('*').eq('code', code).maybeSingle();
    if (error) throw new Error(`territory: ${error.message}`);
    if (!data) return null;
    return {
      ...data,
      min_liquid_capital: Number(data.min_liquid_capital),
      min_net_worth: Number(data.min_net_worth),
    } as TerritoryRow;
  }

  async reps(): Promise<RepRow[]> {
    const { data, error } = await this.sb.from('reps').select('*').eq('is_active', true);
    if (error) throw new Error(`reps: ${error.message}`);
    return data as RepRow[];
  }

  // --- Capacity (atomic, see reserve_rep in schema.sql) -------------------

  /** Takes a seat for this event on the first candidate with capacity. */
  async reserveRep(candidateIds: string[], eventKey: string): Promise<string | null> {
    const { data, error } = await this.sb.rpc('reserve_rep', { candidate_ids: candidateIds, p_event_key: eventKey });
    if (error) throw new Error(`reserve_rep: ${error.message}`);
    return (data as string | null) ?? null;
  }

  /** Links the seat to its opportunity, so closing the opportunity frees the seat. */
  async attachOpportunity(eventKey: string, opportunityId: string): Promise<void> {
    const { error } = await this.sb
      .from('rep_seats')
      .update({ opportunity_id: opportunityId })
      .eq('event_key', eventKey);
    if (error) throw new Error(`attachOpportunity: ${error.message}`);
  }

  async opportunityChanged(opportunityId: string, status: string, assignedEmail: string | null): Promise<SeatChange> {
    const { data, error } = await this.sb.rpc('opportunity_changed', {
      p_opportunity_id: opportunityId,
      p_status: status,
      p_assigned_email: assignedEmail,
    });
    if (error) throw new Error(`opportunity_changed: ${error.message}`);
    return data as SeatChange;
  }

  // --- Decision log --------------------------------------------------------

  async saveDecision(row: {
    event_key: string;
    contact_id: string;
    outcome: Outcome;
    rep_id: string | null;
    territory_code: string | null;
    residence_state: string | null;
    unit_state: string | null;
    reasons: string[];
    ai_extraction: AiExtraction | null;
  }): Promise<void> {
    const { error } = await this.sb.from('routing_decisions').insert(row);
    if (error) throw new Error(`saveDecision: ${error.message}`);
  }

  async waitingDecisions(): Promise<
    { id: string; event_key: string; contact_id: string; residence_state: string; unit_state: string }[]
  > {
    const { data, error } = await this.sb
      .from('routing_decisions')
      .select('id, event_key, contact_id, residence_state, unit_state')
      .eq('outcome', 'waiting_registration')
      .is('resolved_at', null);
    if (error) throw new Error(`waitingDecisions: ${error.message}`);
    return data ?? [];
  }

  async resolveDecision(id: string): Promise<void> {
    const { error } = await this.sb
      .from('routing_decisions')
      .update({ resolved_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw new Error(`resolveDecision: ${error.message}`);
  }

  // --- Used by the simulator only -----------------------------------------

  async setOpenLeads(email: string, openLeads: number): Promise<void> {
    const { error } = await this.sb.from('reps').update({ open_leads: openLeads }).eq('email', email);
    if (error) throw new Error(`setOpenLeads: ${error.message}`);
  }

  async repByEmail(email: string): Promise<RepRow | null> {
    const { data, error } = await this.sb.from('reps').select('*').eq('email', email).maybeSingle();
    if (error) throw new Error(`repByEmail: ${error.message}`);
    return data as RepRow | null;
  }
}
