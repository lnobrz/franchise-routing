-- Hardening after the pre-launch break tests. Run once, after 001.
-- A new database only needs schema.sql.
--
--   - events that fail before the CRM are kept as 'failed' and retried,
--     instead of being deleted (a lead could vanish if GHL didn't retry)
--   - reps.timezone must be a real time zone (a typo crashed routing)
--   - one open seat per contact (a resubmitted form can't assign twice)
--   - opportunity_changed() can find a seat by contact when the opportunity
--     id was never recorded
--   - purge_old_payloads() for PII retention

begin;

-- ---------------------------------------------------------------------------
-- Events: 'failed' status, attempts and last error
-- ---------------------------------------------------------------------------

alter table processed_events drop constraint processed_events_status_check;
alter table processed_events
  add constraint processed_events_status_check
    check (status in ('processing', 'writing_crm', 'done', 'failed', 'needs_attention')),
  add column attempts   integer not null default 0,
  add column last_error text;

drop index if exists processed_events_open_idx;
create index processed_events_open_idx on processed_events (updated_at)
  where status in ('processing', 'writing_crm', 'failed');

-- ---------------------------------------------------------------------------
-- Reps: reject unknown time zones
-- ---------------------------------------------------------------------------

create or replace function check_rep_timezone() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone "%". Use an IANA name such as America/New_York.', new.timezone;
  end if;
  return new;
end;
$$;

create trigger reps_timezone_valid before insert or update of timezone on reps
  for each row execute function check_rep_timezone();

-- ---------------------------------------------------------------------------
-- Seats: contact id, one open seat per contact
-- ---------------------------------------------------------------------------

alter table rep_seats add column contact_id text;
update rep_seats s set contact_id = e.contact_id from processed_events e where e.event_key = s.event_key;
alter table rep_seats alter column contact_id set not null;
create unique index rep_seats_one_open_per_contact on rep_seats (contact_id) where released_at is null;

drop function if exists unclaim_event(text, uuid);
drop function if exists opportunity_changed(text, text, text);

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
    set claim_id = gen_random_uuid(), status = 'processing', updated_at = now()
    where event_key = p_event_key
      and (status = 'failed'
           or (status = 'processing' and updated_at < now() - make_interval(secs => stale_seconds)))
    returning claim_id into claimed;
  if claimed is not null then
    perform release_event_seat(p_event_key);
  end if;

  return claimed;
end;
$$;

-- An event that failed before reaching the CRM: its seat is given back and it
-- is kept as 'failed' (with its payload), so GHL's retry or the recovery job
-- can run it again. Nothing is deleted, so a lead can't vanish.
create or replace function fail_event(p_event_key text, p_claim_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 'writing_crm' too: the app only calls this when it knows nothing was
  -- written (e.g. GHL refused the very first write).
  perform 1 from processed_events
    where event_key = p_event_key and claim_id = p_claim_id and status in ('processing', 'writing_crm')
    for update;
  if found then
    perform release_event_seat(p_event_key);
    update processed_events
      set status = 'failed', attempts = attempts + 1, last_error = left(p_error, 500), updated_at = now()
      where event_key = p_event_key;
  end if;
end;
$$;

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
    insert into rep_seats (event_key, contact_id, rep_id)
      select p_event_key, contact_id, chosen from processed_events where event_key = p_event_key;
  end if;

  return chosen;
end;
$$;

create or replace function opportunity_changed(
  p_opportunity_id text, p_status text, p_assigned_email text, p_contact_id text default null
)
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
  if not found and coalesce(p_contact_id, '') <> '' then
    select * into seat from rep_seats
      where contact_id = p_contact_id and opportunity_id is null and released_at is null
      for update;
    if found then
      update rep_seats set opportunity_id = p_opportunity_id where event_key = seat.event_key;
    end if;
  end if;
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

create or replace function purge_old_payloads(retention_days integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cleared integer;
begin
  update processed_events e set payload = '{}'::jsonb
    where e.status in ('done', 'needs_attention')
      and e.updated_at < now() - make_interval(days => retention_days)
      and e.payload <> '{}'::jsonb
      and not exists (
        select 1 from routing_decisions d
        where d.event_key = e.event_key and d.outcome = 'waiting_registration' and d.resolved_at is null
      );
  get diagnostics cleared = row_count;
  update routing_decisions set ai_extraction = null
    where ai_extraction is not null and created_at < now() - make_interval(days => retention_days);
  return cleared;
end;
$$;

revoke execute on function fail_event(text, uuid, text)              from public, anon, authenticated;
revoke execute on function opportunity_changed(text, text, text, text) from public, anon, authenticated;
revoke execute on function purge_old_payloads(integer)                from public, anon, authenticated;
grant  execute on function fail_event(text, uuid, text)              to service_role;
grant  execute on function opportunity_changed(text, text, text, text) to service_role;
grant  execute on function purge_old_payloads(integer)                to service_role;

commit;
