import type { Language } from './rules/normalize.js';

// Rows as they come from Supabase.

export type RegistrationStatus =
  | 'not_required'
  | 'active'
  | 'renewal_pending'
  | 'expired'
  | 'not_registered';

export interface StateRow {
  code: string;
  name: string;
  registration_status: RegistrationStatus;
  registration_expires_at: string | null; // YYYY-MM-DD
  total_slots: number;
  sold_slots: number;
}

export interface RepRow {
  id: string;
  full_name: string;
  email: string;
  covered_states: string[];
  languages: Language[];
  timezone: string;
  work_start: string; // HH:MM:SS
  work_end: string;
  work_days: number[]; // ISO weekday, 1 = Monday
  max_open_leads: number;
  open_leads: number;
  is_active: boolean;
}

export interface TerritoryRow {
  code: string;
  name: string;
  state_code: string;
  status: 'available' | 'reserved' | 'sold';
  owner_rep_id: string | null;
  min_liquid_capital: number;
  min_net_worth: number;
}

export interface ZipRow {
  zip: string;
  city: string | null;
  state_code: string;
  territory_code: string | null;
}

// What we know about a lead after merging the form with the AI read.

export interface LeadFacts {
  residenceState?: string;
  unitState?: string;
  zip?: string;
  liquidCapital?: number;
  netWorth?: number;
  language: Language;
}

export type Outcome = 'assigned' | 'blocked' | 'waiting_registration' | 'needs_review';
