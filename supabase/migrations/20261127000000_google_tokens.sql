-- Each Google account's refresh token, so the website stays signed in: the Edge
-- Functions use it to get a fresh hour-long Google token when the browser asks.
-- Tasks are never stored here.
--
-- Nobody's browser can reach this table: row-level security is on with no policies,
-- and only the service role (the functions) is granted access. The token itself is
-- encrypted by the functions (AES-GCM) with a key that isn't in the database.

create table public.google_tokens (
  google_sub    text primary key,                          -- Google's ID for the account
  user_id       uuid references auth.users on delete cascade, -- set once they've a session
  refresh_token text not null,                             -- base64 of IV + ciphertext
  scopes        text not null default '',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now()
);

alter table public.google_tokens enable row level security;
revoke all on public.google_tokens from anon, authenticated;
grant select, insert, update, delete on public.google_tokens to service_role;

create index google_tokens_user_id on public.google_tokens (user_id);

-- Unused for six months: Google stops honouring the token then anyway, and it's not
-- ours to keep (UK GDPR storage limitation). Daily at 03:00.
create extension if not exists pg_cron;
select cron.schedule(
  'delete-unused-google-tokens',
  '0 3 * * *',
  $$delete from public.google_tokens where last_used_at < now() - interval '6 months'$$
);
