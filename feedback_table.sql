-- Barcode Blitz anonymous feedback table (Supabase / Postgres).
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run.
create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  build text not null check (char_length(build) <= 12),
  scanner smallint not null check (scanner between -1 and 4),
  pacing smallint not null check (pacing between -1 and 4),
  clarity smallint not null check (clarity between -1 and 4),
  bugs smallint not null check (bugs between -1 and 4),
  bug_area text not null default '' check (bug_area in ('', 'campaign', 'wave', 'rival', 'menus'))
);

-- Row Level Security on with no policies: the public anon key can't read or
-- write. Only the relay, using the service_role key from Render's environment,
-- can insert rows and read them for the results page.
alter table public.feedback enable row level security;
