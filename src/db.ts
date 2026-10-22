import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Outcome, RepRow, StateRow, TerritoryRow, ZipRow } from './types.js';
import type { LeadPayload } from './payload.js';
import type { AiExtraction } from './ai/extract.js';

export class Db {
  private sb: SupabaseClient;

  constructor(url: string, secretKey: string) {
    this.sb = createClient(url, secretKey, { auth: { persistSession: false } });
  }

  // --- Idempotency -------------------------------------------------------

  /** Returns false when this exact event was already accepted (GHL retry, double submit). */
  async claimEvent(eventKey: string, contactId: string, payload: LeadPayload): Promise<boolean> {
    const { error } = await this.sb
      .from('processed_events')
      .insert({ event_key: eventKey, contact_id: contactId, payload });
    if (!error) return true;
    if (error.code === '23505') return false; // unique violation: already processed
    throw new Error(`claimEvent: ${error.message}`);
  }

  /** Lets a failed event be retried by GHL. */
  async unclaimEvent(eventKey: string): Promise<void> {
    await this.sb.from('processed_events').delete().eq('event_key', eventKey);
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

  async reserveRep(candidateIds: string[]): Promise<string | null> {
    const { data, error } = await this.sb.rpc('reserve_rep', { candidate_ids: candidateIds });
    if (error) throw new Error(`reserve_rep: ${error.message}`);
    return (data as string | null) ?? null;
  }

  async releaseRep(repId: string): Promise<void> {
    const { error } = await this.sb.rpc('release_rep', { rep: repId });
    if (error) throw new Error(`release_rep: ${error.message}`);
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
