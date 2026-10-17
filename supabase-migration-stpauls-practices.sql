-- St. Paul's team practices: church teams book a Mesa trainer to run a
-- 1-hour practice inside the church's practice blocks (see
-- src/lib/stpauls.ts). Deliberately its own table, not registrations, so
-- nothing that reads registrations — admin Upcoming/Past/Calendar,
-- Payments, payroll sync, stats, mass messages — ever sees these. No
-- Stripe: the coach pays the trainer $60 cash at practice.
CREATE TABLE IF NOT EXISTS stpauls_practices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  practice_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  team_name text NOT NULL,
  coaches jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ name, phone, email }]
  booked_by_user_id uuid,
  booked_by_email text NOT NULL,
  booked_by_name text,
  assigned_trainer text,               -- null = TBD; only the admin sets it
  status text NOT NULL DEFAULT 'booked', -- 'booked' | 'cancelled'
  cancelled_at timestamptz,
  CHECK (end_time > start_time),
  -- Once a team takes an hour, nobody can book any overlapping time. Enforced
  -- here, not just in the API, so two coaches submitting at the same moment
  -- can't both get the same slot.
  CONSTRAINT stpauls_practices_no_overlap EXCLUDE USING gist (
    tsrange(practice_date + start_time, practice_date + end_time) WITH &&
  ) WHERE (status = 'booked')
);

CREATE INDEX IF NOT EXISTS stpauls_practices_date_idx ON stpauls_practices (practice_date);
CREATE INDEX IF NOT EXISTS stpauls_practices_booked_by_idx ON stpauls_practices (booked_by_email);

-- Matches every other table in this project: all access goes through Next.js
-- API routes using the service role key, which bypasses RLS.
ALTER TABLE stpauls_practices ENABLE ROW LEVEL SECURITY;
