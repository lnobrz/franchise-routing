-- Franchise lead routing: database schema
--
-- Reference data (states, ZIPs, territories, reps) is edited by the ops team
-- in the Supabase table editor. The constraints below reject bad edits
-- (wrong status, sold > total, missing expiry date) so nobody needs a developer
-- to keep the data valid.
--
-- RLS is enabled on every table with no policies: only the server (service role
-- key) can read or write through the API. The dashboard still works for ops.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type registration_status as enum (
  'not_required',     -- state has no franchise registration law
  'active',           -- registered and valid until registration_expires_at
  'renewal_pending',  -- renewal filed, cannot offer until approved
  'expired',          -- registration lapsed
  'not_registered'    -- registration state where we never registered
);

create type territory_status as enum ('available', 'reserved', 'sold');

create type routing_outcome as enum (
  'assigned',              -- rep assigned, opportunity created
  'blocked',               -- cannot sell (no slots, not registered, unqualified)
  'waiting_registration',  -- parked until a state registration is active again
  'needs_review'           -- AI could not read the lead safely, or nobody fits
);

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at current on every edit
-- ---------------------------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- States: legal status and franchise slots per state
-- ---------------------------------------------------------------------------

create table states (
  code                    char(2) primary key check (code ~ '^[A-Z]{2}$'),
  name                    text not null,
  registration_status     registration_status not null default 'not_required',
  registration_expires_at date,
  total_slots             integer not null default 0 check (total_slots >= 0),
  sold_slots              integer not null default 0 check (sold_slots >= 0),
  notes                   text,
  updated_at              timestamptz not null default now(),

  constraint sold_within_total check (sold_slots <= total_slots),
  constraint active_needs_expiry check (
    registration_status <> 'active' or registration_expires_at is not null
  )
);

create trigger states_updated_at before update on states
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Reps: who can receive leads, and under which conditions
-- ---------------------------------------------------------------------------

create table reps (
  id              uuid primary key default gen_random_uuid(),
  full_name       text not null,
  email           text not null unique check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  covered_states  char(2)[] not null default '{}',
  languages       text[] not null default array['English']
                  check (languages <@ array['English', 'Spanish', 'Portuguese']
                         and cardinality(languages) > 0),
  timezone        text not null default 'America/New_York',
  work_start      time not null default '09:00',
  work_end        time not null default '18:00',
  work_days       smallint[] not null default array[1,2,3,4,5]::smallint[]
                  check (work_days <@ array[1,2,3,4,5,6,7]::smallint[]),  -- ISO: 1 = Monday
  max_open_leads  integer not null default 10 check (max_open_leads > 0),
  open_leads      integer not null default 0 check (open_leads >= 0),
  is_active       boolean not null default true,
  updated_at      timestamptz not null default now(),

  constraint work_hours_order check (work_start < work_end)
);

create trigger reps_updated_at before update on reps
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Territories and the ZIP codes they cover
-- ---------------------------------------------------------------------------

create table territories (
  code               text primary key,
  name               text not null,
  state_code         char(2) not null references states(code),
  status             territory_status not null default 'available',
  owner_rep_id       uuid references reps(id),
  min_liquid_capital numeric(14,2) not null default 0 check (min_liquid_capital >= 0),
  min_net_worth      numeric(14,2) not null default 0 check (min_net_worth >= 0),
  updated_at         timestamptz not null default now()
);

create trigger territories_updated_at before update on territories
  for each row execute function set_updated_at();

create table zip_codes (
  zip            char(5) primary key check (zip ~ '^[0-9]{5}$'),
  city           text,
  state_code     char(2) not null references states(code),
  territory_code text references territories(code)
);

create index zip_codes_territory_idx on zip_codes (territory_code);

-- ---------------------------------------------------------------------------
-- Webhook idempotency: one row per event the server has accepted
-- ---------------------------------------------------------------------------

create table processed_events (
  event_key   text primary key,   -- contact id + hash of the submitted answers
  contact_id  text not null,
  payload     jsonb not null,     -- kept so waiting leads can be re-routed later
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Decision log: why every lead went where it went
-- ---------------------------------------------------------------------------

create table routing_decisions (
  id               uuid primary key default gen_random_uuid(),
  event_key        text not null references processed_events(event_key),
  contact_id       text not null,
  outcome          routing_outcome not null,
  rep_id           uuid references reps(id),
  territory_code   text references territories(code),
  residence_state  char(2),
  unit_state       char(2),
  reasons          text[] not null default '{}',
  ai_extraction    jsonb,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz           -- set when a waiting lead is re-routed
);

create index routing_decisions_contact_idx on routing_decisions (contact_id);
create index routing_decisions_waiting_idx on routing_decisions (outcome)
  where outcome = 'waiting_registration' and resolved_at is null;

-- ---------------------------------------------------------------------------
-- Atomic seat reservation
--
-- The app sends candidate reps already sorted by priority. This function locks
-- all of them (in id order, so two calls can never deadlock), then gives the
-- lead to the first one with free capacity. Two leads arriving at the same time
-- wait for each other here instead of both seeing "7 of 8" and both taking it.
-- ---------------------------------------------------------------------------

create or replace function reserve_rep(candidate_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  chosen uuid;
begin
  perform 1 from reps
    where id = any(candidate_ids)
    order by id
    for update;

  select r.id into chosen
    from unnest(candidate_ids) with ordinality as c(id, priority)
    join reps r on r.id = c.id
    where r.is_active and r.open_leads < r.max_open_leads
    order by c.priority
    limit 1;

  if chosen is not null then
    update reps set open_leads = open_leads + 1 where id = chosen;
  end if;

  return chosen;
end;
$$;

-- Frees a seat when a lead leaves the rep's queue (closed, lost, reassigned).
create or replace function release_rep(rep uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update reps set open_leads = greatest(open_leads - 1, 0) where id = rep;
$$;

-- ---------------------------------------------------------------------------
-- Lock everything down to the server
-- ---------------------------------------------------------------------------

alter table states            enable row level security;
alter table reps              enable row level security;
alter table territories       enable row level security;
alter table zip_codes         enable row level security;
alter table processed_events  enable row level security;
alter table routing_decisions enable row level security;

revoke execute on function reserve_rep(uuid[]) from public, anon, authenticated;
revoke execute on function release_rep(uuid)   from public, anon, authenticated;
grant  execute on function reserve_rep(uuid[]) to service_role;
grant  execute on function release_rep(uuid)   to service_role;
