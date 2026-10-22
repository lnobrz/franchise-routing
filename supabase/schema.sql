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
  -- processing:      claimed, nothing sent to the CRM yet (safe to run again)
  -- writing_crm:     the CRM is being written (never re-run automatically)
  -- done:            decision logged
  -- needs_attention: failed after touching the CRM, a person has to look
  status      text not null default 'processing'
              check (status in ('processing', 'writing_crm', 'done', 'needs_attention')),
  claim_id    uuid not null default gen_random_uuid(),  -- which run owns the event
  received_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index processed_events_open_idx on processed_events (updated_at)
  where status in ('processing', 'writing_crm');

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
-- Seats: one row per lead a rep is holding
--
-- reps.open_leads is the counter reserve_rep() checks; rep_seats says which
-- lead holds each seat, so the seat can be given back when the opportunity is
-- won, lost, abandoned or handed to someone else (opportunity_changed below).
-- ---------------------------------------------------------------------------

create table rep_seats (
  event_key      text primary key references processed_events(event_key),
  rep_id         uuid not null references reps(id),
  opportunity_id text unique,          -- set once the opportunity exists in the CRM
  taken_at       timestamptz not null default now(),
  released_at    timestamptz
);

create index rep_seats_rep_idx on rep_seats (rep_id) where released_at is null;

-- ---------------------------------------------------------------------------
-- Event claims
--
-- claim_event() returns a claim id, or null when the event is already taken.
-- An event stuck in 'processing' (the server died before writing to the CRM)
-- can be claimed again once it is older than stale_seconds; its seat, if it
-- took one, is given back first. Every later status change must present the
-- claim id, so a run that lost its claim can't write over the new one.
-- ---------------------------------------------------------------------------

create or replace function release_event_seat(p_event_key text)
returns void
language sql
security definer
set search_path = public
as $$
  with seat as (
    delete from rep_seats where event_key = p_event_key returning rep_id, released_at
  )
  update reps set open_leads = greatest(open_leads - 1, 0)
    where id in (select rep_id from seat where released_at is null);
$$;

create or replace function claim_event(p_event_key text, p_contact_id text, p_payload jsonb, stale_seconds integer)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed uuid;
begin
  insert into processed_events (event_key, contact_id, payload)
    values (p_event_key, p_contact_id, p_payload)
    on conflict (event_key) do nothing
    returning claim_id into claimed;
  if claimed is not null then
    return claimed;
  end if;

  update processed_events
    set claim_id = gen_random_uuid(), updated_at = now()
    where event_key = p_event_key
      and status = 'processing'
      and updated_at < now() - make_interval(secs => stale_seconds)
    returning claim_id into claimed;
  if claimed is not null then
    perform release_event_seat(p_event_key);
  end if;

  return claimed;
end;
$$;

-- Lets GHL's retry process an event that failed before reaching the CRM.
create or replace function unclaim_event(p_event_key text, p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from processed_events
    where event_key = p_event_key and claim_id = p_claim_id and status <> 'done'
    for update;
  if found then
    perform release_event_seat(p_event_key);
    delete from processed_events where event_key = p_event_key;
  end if;
end;
$$;

-- Without a claim id (the recovery job), the status is set unconditionally.
create or replace function set_event_status(p_event_key text, p_status text, p_claim_id uuid default null)
returns boolean
language sql
security definer
set search_path = public
as $$
  with changed as (
    update processed_events set status = p_status, updated_at = now()
      where event_key = p_event_key and (p_claim_id is null or claim_id = p_claim_id)
      returning 1
  )
  select exists (select 1 from changed);
$$;

-- ---------------------------------------------------------------------------
-- Atomic seat reservation
--
-- The app sends candidate reps already sorted by priority. This function locks
-- all of them (in id order, so two calls can never deadlock), then gives the
-- lead to the first one with free capacity. Two leads arriving at the same time
-- wait for each other here instead of both seeing "7 of 8" and both taking it.
-- The seat is recorded against the event in the same transaction.
-- ---------------------------------------------------------------------------

create or replace function reserve_rep(candidate_ids uuid[], p_event_key text)
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
    insert into rep_seats (event_key, rep_id) values (p_event_key, chosen);
  end if;

  return chosen;
end;
$$;

-- ---------------------------------------------------------------------------
-- Opportunity changes from the CRM (POST /webhooks/opportunity)
--
--   status won / lost / abandoned       -> the seat is given back
--   reassigned to another routed rep    -> the seat moves to that rep
--   reassigned to someone not in reps   -> the seat is given back
--
-- Returns what happened: released, moved, unchanged or ignored (unknown
-- opportunity, or its seat was already given back). Safe to call repeatedly.
-- ---------------------------------------------------------------------------

create or replace function opportunity_changed(p_opportunity_id text, p_status text, p_assigned_email text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  seat rep_seats%rowtype;
  new_rep uuid;
begin
  select * into seat from rep_seats where opportunity_id = p_opportunity_id for update;
  if not found or seat.released_at is not null then
    return 'ignored';
  end if;

  if lower(p_status) <> 'open' then
    update rep_seats set released_at = now() where event_key = seat.event_key;
    update reps set open_leads = greatest(open_leads - 1, 0) where id = seat.rep_id;
    return 'released';
  end if;

  if coalesce(p_assigned_email, '') = '' then
    return 'unchanged';
  end if;

  select id into new_rep from reps where lower(email) = lower(p_assigned_email);
  if new_rep = seat.rep_id then
    return 'unchanged';
  end if;

  if new_rep is null then
    update rep_seats set released_at = now() where event_key = seat.event_key;
    update reps set open_leads = greatest(open_leads - 1, 0) where id = seat.rep_id;
    return 'released';
  end if;

  -- A person chose this rep, so the move is allowed even above their capacity.
  perform 1 from reps where id in (seat.rep_id, new_rep) order by id for update;
  update reps set open_leads = greatest(open_leads - 1, 0) where id = seat.rep_id;
  update reps set open_leads = open_leads + 1 where id = new_rep;
  update rep_seats set rep_id = new_rep where event_key = seat.event_key;
  return 'moved';
end;
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
alter table rep_seats         enable row level security;

revoke execute on function release_event_seat(text)                  from public, anon, authenticated;
revoke execute on function claim_event(text, text, jsonb, integer)   from public, anon, authenticated;
revoke execute on function unclaim_event(text, uuid)                 from public, anon, authenticated;
revoke execute on function set_event_status(text, text, uuid)        from public, anon, authenticated;
revoke execute on function reserve_rep(uuid[], text)                 from public, anon, authenticated;
revoke execute on function opportunity_changed(text, text, text)     from public, anon, authenticated;
grant  execute on function release_event_seat(text)                  to service_role;
grant  execute on function claim_event(text, text, jsonb, integer)   to service_role;
grant  execute on function unclaim_event(text, uuid)                 to service_role;
grant  execute on function set_event_status(text, text, uuid)        to service_role;
grant  execute on function reserve_rep(uuid[], text)                 to service_role;
grant  execute on function opportunity_changed(text, text, text)     to service_role;
