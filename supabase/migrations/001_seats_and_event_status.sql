-- Upgrades a database created with the first version of schema.sql.
-- A new database only needs schema.sql. Run this once, in the SQL editor.
--
-- Adds: event status and claim id (stuck events are recovered), rep_seats and
-- opportunity_changed() (seats are given back), and replaces release_rep() and
-- the one-argument reserve_rep().

begin;

alter table processed_events
  add column status text not null default 'done'
    check (status in ('processing', 'writing_crm', 'done', 'needs_attention')),
  add column claim_id uuid not null default gen_random_uuid(),
  add column updated_at timestamptz not null default now();

-- Existing rows were all accepted by the old code; new rows start as processing.
alter table processed_events alter column status set default 'processing';

create index processed_events_open_idx on processed_events (updated_at)
  where status in ('processing', 'writing_crm');

drop function if exists reserve_rep(uuid[]);
drop function if exists release_rep(uuid);

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

commit;

-- Leads assigned before this migration have no row in rep_seats, so closing
-- their opportunities won't give the seat back. Set reps.open_leads to each
-- rep's real number of open leads once, after running this.
