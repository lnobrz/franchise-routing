-- Demo data. All of it is invented for the demo.
-- The registration-state list mirrors the real set of US states with franchise
-- registration laws; the statuses, dates and slot counts are fictional.

-- ---------------------------------------------------------------------------
-- States
-- ---------------------------------------------------------------------------

insert into states (code, name, registration_status, registration_expires_at, total_slots, sold_slots, notes) values
  -- Registration states
  ('CA', 'California',   'active',          '2027-04-30', 6, 2, null),
  ('NY', 'New York',     'renewal_pending', '2026-09-30', 5, 0, 'Renewal filed 2026-09-15'),
  ('IL', 'Illinois',     'expired',         '2026-06-30', 4, 1, 'Renewal not filed yet'),
  ('MD', 'Maryland',     'active',          '2027-03-31', 3, 0, null),
  ('VA', 'Virginia',     'active',          '2027-05-31', 3, 0, null),
  ('WA', 'Washington',   'not_registered',  null,         0, 0, null),
  ('HI', 'Hawaii',       'not_registered',  null,         0, 0, null),
  ('IN', 'Indiana',      'not_registered',  null,         0, 0, null),
  ('MI', 'Michigan',     'not_registered',  null,         0, 0, null),
  ('MN', 'Minnesota',    'not_registered',  null,         0, 0, null),
  ('ND', 'North Dakota', 'not_registered',  null,         0, 0, null),
  ('RI', 'Rhode Island', 'not_registered',  null,         0, 0, null),
  ('SD', 'South Dakota', 'not_registered',  null,         0, 0, null),
  ('WI', 'Wisconsin',    'not_registered',  null,         0, 0, null),
  -- Non-registration states
  ('FL', 'Florida',      'not_required',    null,        10, 3, null),
  ('TX', 'Texas',        'not_required',    null,         8, 7, 'One slot left'),
  ('NJ', 'New Jersey',   'not_required',    null,         4, 1, null),
  ('GA', 'Georgia',      'not_required',    null,         5, 2, null),
  ('AZ', 'Arizona',      'not_required',    null,         3, 3, 'Sold out');

-- ---------------------------------------------------------------------------
-- Reps (the same four users created in the CRM)
-- ---------------------------------------------------------------------------

insert into reps (full_name, email, covered_states, languages, timezone, work_start, work_end, max_open_leads) values
  ('Ana Rodriguez', 'ana.rodriguez@example.com', '{FL,GA}',    '{English,Spanish}',    'America/New_York',    '09:00', '18:00', 8),
  ('Mike Thompson', 'mike.thompson@example.com', '{TX,AZ}',    '{English}',            'America/Chicago',     '08:00', '17:00', 8),
  ('Sarah Chen',    'sarah.chen@example.com',    '{CA}',       '{English}',            'America/Los_Angeles', '09:00', '18:00', 6),
  ('Carlos Silva',  'carlos.silva@example.com',  '{NJ,NY,MD,VA}', '{English,Portuguese}', 'America/New_York', '09:00', '18:00', 8);

-- ---------------------------------------------------------------------------
-- Territories
-- ---------------------------------------------------------------------------

insert into territories (code, name, state_code, status, owner_rep_id, min_liquid_capital, min_net_worth) values
  ('MIA-01', 'Miami Central',   'FL', 'available', (select id from reps where email = 'ana.rodriguez@example.com'), 150000, 500000),
  ('ORL-01', 'Orlando',         'FL', 'sold',      (select id from reps where email = 'ana.rodriguez@example.com'), 150000, 500000),
  ('HOU-01', 'Houston Downtown','TX', 'available', (select id from reps where email = 'mike.thompson@example.com'), 120000, 400000),
  ('DAL-01', 'Dallas Uptown',   'TX', 'reserved',  (select id from reps where email = 'mike.thompson@example.com'), 120000, 400000),
  ('LAX-01', 'Los Angeles DTLA','CA', 'available', (select id from reps where email = 'sarah.chen@example.com'),    200000, 750000),
  ('SFO-01', 'San Francisco',   'CA', 'available', (select id from reps where email = 'sarah.chen@example.com'),    200000, 750000),
  ('NWK-01', 'Newark',          'NJ', 'available', (select id from reps where email = 'carlos.silva@example.com'),  120000, 400000),
  ('NYC-01', 'Manhattan South', 'NY', 'available', (select id from reps where email = 'carlos.silva@example.com'),  250000, 1000000),
  ('PHX-01', 'Phoenix Central', 'AZ', 'available', (select id from reps where email = 'mike.thompson@example.com'), 120000, 400000),
  ('CHI-01', 'Chicago Loop',    'IL', 'available', null,                                                           150000, 500000);

-- ---------------------------------------------------------------------------
-- ZIP codes (a demo subset; the full US list can be loaded the same way)
-- ---------------------------------------------------------------------------

insert into zip_codes (zip, city, state_code, territory_code) values
  ('33101', 'Miami',         'FL', 'MIA-01'),
  ('33125', 'Miami',         'FL', 'MIA-01'),
  ('33130', 'Miami',         'FL', 'MIA-01'),
  ('33131', 'Miami',         'FL', 'MIA-01'),
  ('32801', 'Orlando',       'FL', 'ORL-01'),
  ('32803', 'Orlando',       'FL', 'ORL-01'),
  ('33601', 'Tampa',         'FL', null),
  ('77002', 'Houston',       'TX', 'HOU-01'),
  ('77003', 'Houston',       'TX', 'HOU-01'),
  ('77004', 'Houston',       'TX', 'HOU-01'),
  ('75201', 'Dallas',        'TX', 'DAL-01'),
  ('75202', 'Dallas',        'TX', 'DAL-01'),
  ('78701', 'Austin',        'TX', null),
  ('90012', 'Los Angeles',   'CA', 'LAX-01'),
  ('90013', 'Los Angeles',   'CA', 'LAX-01'),
  ('90014', 'Los Angeles',   'CA', 'LAX-01'),
  ('94102', 'San Francisco', 'CA', 'SFO-01'),
  ('94103', 'San Francisco', 'CA', 'SFO-01'),
  ('07102', 'Newark',        'NJ', 'NWK-01'),
  ('07103', 'Newark',        'NJ', 'NWK-01'),
  ('07104', 'Newark',        'NJ', 'NWK-01'),
  ('07302', 'Jersey City',   'NJ', null),
  ('10001', 'New York',      'NY', 'NYC-01'),
  ('10002', 'New York',      'NY', 'NYC-01'),
  ('10003', 'New York',      'NY', 'NYC-01'),
  ('85003', 'Phoenix',       'AZ', 'PHX-01'),
  ('85004', 'Phoenix',       'AZ', 'PHX-01'),
  ('60601', 'Chicago',       'IL', 'CHI-01'),
  ('60602', 'Chicago',       'IL', 'CHI-01'),
  ('30303', 'Atlanta',       'GA', null),
  ('21201', 'Baltimore',     'MD', null);
