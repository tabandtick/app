-- Shared lists in everyone's Google Tasks. Each member of a shared list has it as a
-- normal Google Tasks list in their own account (their "copy"), and the server keeps
-- the copies matched: see supabase/functions/_shared/copies.ts. The shared list's
-- tables (lists, tasks) are the record in the middle, which says what changed where.
--
-- The server reaches each member's Google Tasks with the refresh token kept in
-- google_tokens, and only ever touches these copies, by their saved IDs.

-- ---- Each member's Google list for a shared list

create table public.google_copies (
  list_id      uuid not null references public.lists on delete cascade,
  user_id      uuid not null references auth.users on delete cascade,
  tasklist     text check (length(tasklist) <= 200), -- their Google list's ID, once made
  wanted       boolean not null default true,      -- false once they delete it in Google
  state        text not null default 'new' check (state in ('new', 'on', 'needs_permission', 'off', 'error')),
  title_seen   text,          -- the list's name as last agreed with Google
  pulled_to    text,          -- the newest Google change seen (Google's clock)
  order_seen   timestamptz,   -- when its order was last read: Google doesn't say when a task moves
  dirty        boolean not null default true, -- the shared list changed since
  locked_until timestamptz,   -- being synced until then
  next_try     timestamptz,   -- Google asked us to wait
  error        text,
  synced_at    timestamptz,
  created_at   timestamptz not null default now(),
  primary key (list_id, user_id)
);
create unique index google_copies_tasklist on public.google_copies (user_id, tasklist);

-- Which task in a member's Google list is which shared task, and the fields as last
-- agreed between the two (base), which is how a sync knows which side changed what.
create table public.google_copy_tasks (
  list_id   uuid not null,
  user_id   uuid not null,
  task_id   text not null,
  google_id text,             -- null while it's being made in Google
  base      jsonb not null,
  primary key (list_id, user_id, task_id),
  foreign key (list_id, user_id) references public.google_copies on delete cascade
);
create unique index google_copy_tasks_google on public.google_copy_tasks (list_id, user_id, google_id);

-- Google lists to delete: someone left, was removed, or the list was deleted.
create table public.google_copies_to_remove (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users on delete cascade,
  tasklist   text not null,
  created_at timestamptz not null default now()
);

-- The hour-long Google token, kept (sealed) so each sync doesn't renew it.
alter table public.google_tokens add column access_token text, add column access_until timestamptz;

alter table public.google_copies enable row level security;
alter table public.google_copy_tasks enable row level security;
alter table public.google_copies_to_remove enable row level security;
revoke all on public.google_copies, public.google_copy_tasks, public.google_copies_to_remove from anon, authenticated;
grant select on public.google_copies, public.google_copy_tasks to authenticated;
grant all on public.google_copies, public.google_copy_tasks, public.google_copies_to_remove to service_role;

create policy "your own copies" on public.google_copies for select to authenticated
  using (user_id = auth.uid());
create policy "your own copies' tasks" on public.google_copy_tasks for select to authenticated
  using (user_id = auth.uid());

-- ---- Made and removed with membership

-- Joining (the owner too) gives you a copy, made at the next sync.
create function public.copy_for_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.user_id is not null then
    insert into public.google_copies (list_id, user_id) values (new.list_id, new.user_id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger copy_for_member after insert or update of user_id on public.list_members
  for each row execute function public.copy_for_member();

-- Leaving, or being removed: your copy goes.
create function public.uncopy_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.user_id is not null then
    delete from public.google_copies where list_id = old.list_id and user_id = old.user_id;
  end if;
  return old;
end;
$$;
create trigger uncopy_member after delete on public.list_members
  for each row execute function public.uncopy_member();

-- A copy that goes (also when its list is deleted) is deleted from Google too.
create function public.queue_copy_removal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.tasklist is not null then
    insert into public.google_copies_to_remove (user_id, tasklist) values (old.user_id, old.tasklist);
  end if;
  return old;
end;
$$;
create trigger queue_copy_removal before delete on public.google_copies
  for each row execute function public.queue_copy_removal();

-- Copies for those already in shared lists
insert into public.google_copies (list_id, user_id)
select list_id, user_id from public.list_members where user_id is not null
on conflict do nothing;

-- ---- Who changed it, when the server applies a change from someone's Google list

-- As before, a signed-in person is always recorded as themselves. The server (with no
-- user) records whoever's Google list the change came from: apply_copy_changes() sets
-- tabandtick.by, which nobody else can set.
create or replace function public.touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'tasks' then
    new.updated := now();
    new.updated_by := coalesce(auth.uid(), nullif(current_setting('tabandtick.by', true), '')::uuid);
    if tg_op = 'UPDATE' then new.list_id := old.list_id; new.id := old.id; end if;
  else
    new.updated_at := now();
    if tg_op = 'UPDATE' then new.owner := old.owner; new.created_at := old.created_at; end if;
  end if;
  return new;
end;
$$;

-- ---- Waking the sync when a shared list changes

create extension if not exists pg_net with schema extensions;

-- The key the cron and triggers send, so only they (and signed-in members, for their
-- own copies) can start a sync. Made here; nobody needs to see it.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'google_copies_key')
where not exists (select 1 from vault.secrets where name = 'google_copies_key');

create function public.copies_key() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'google_copies_key';
$$;

-- Asks the function to sync the copies of these lists (null: any that are due). Needs
-- the project's address in the vault as project_url, set when deploying; without it
-- (as on a laptop), it does nothing.
create function public.wake_copies(l uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare url text;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'project_url';
  if url is null then return; end if;
  perform net.http_post(
    url := url || '/functions/v1/google-copies',
    body := jsonb_build_object('lists', to_jsonb(l)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-copies-key', public.copies_key()),
    timeout_milliseconds := 5000);
end;
$$;

-- A shared task changed: the list's copies are behind, apart from the one the change
-- came from (tabandtick.copy, set by apply_copy_changes).
create function public.copies_behind() returns trigger
language plpgsql security definer set search_path = '' as $$
declare changed uuid[];
begin
  select array_agg(distinct list_id) into changed from new_rows;
  if changed is null then return null; end if;
  update public.google_copies set dirty = true
  where list_id = any (changed) and wanted
    and user_id is distinct from nullif(current_setting('tabandtick.copy', true), '')::uuid;
  if found then perform public.wake_copies(changed); end if;
  return null;
end;
$$;
create trigger copies_behind_insert after insert on public.tasks
  referencing new table as new_rows for each statement execute function public.copies_behind();
create trigger copies_behind_update after update on public.tasks
  referencing new table as new_rows for each statement execute function public.copies_behind();

create function public.copies_renamed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.title is distinct from old.title then
    update public.google_copies set dirty = true
    where list_id = new.id and wanted
      and user_id is distinct from nullif(current_setting('tabandtick.copy', true), '')::uuid;
    if found then perform public.wake_copies(array[new.id]); end if;
  end if;
  return null;
end;
$$;
create trigger copies_renamed after update on public.lists
  for each row execute function public.copies_renamed();

-- A new copy to make
create function public.copy_made() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.wake_copies(array[new.list_id]);
  return null;
end;
$$;
create trigger copy_made after insert on public.google_copies
  for each row execute function public.copy_made();

-- Every minute: copies not synced for a while (for changes made in Google's apps,
-- which Google doesn't announce), and Google lists waiting to be deleted.
select cron.schedule('google-copies', '* * * * *', $$select public.wake_copies(null)$$);

-- Lists waiting to be deleted for someone whose permission is gone go after a week.
select cron.schedule(
  'forget-old-copy-removals',
  '20 3 * * *',
  $$delete from public.google_copies_to_remove where created_at < now() - interval '7 days'$$
);

-- ---- For the sync (service role only)

-- Takes copies to sync, so no other run touches them meanwhile: those of the given
-- list (and user), or, given neither, any that are behind or not synced for 50 s.
-- With only_dirty, only those behind. Each comes with its owner's Google account ID.
create function public.claim_copies(l uuid default null, u uuid default null, only_dirty boolean default false, how_many integer default 20)
returns table (list_id uuid, user_id uuid, tasklist text, state text, title_seen text, pulled_to text, order_seen timestamptz, google_sub text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
begin
  return query
  with picked as (
    select c.list_id, c.user_id from public.google_copies c
    where c.wanted
      and (c.locked_until is null or c.locked_until < now())
      and (l is null or c.list_id = l) and (u is null or c.user_id = u)
      and (c.next_try is null or c.next_try <= now() or u is not null)
      and (not only_dirty or c.dirty)
      and (l is not null or c.dirty or c.synced_at is null or c.synced_at < now() - interval '50 seconds')
      and (c.state <> 'needs_permission' or u is not null or exists (
        select 1 from public.google_tokens t join auth.identities i on i.provider_id = t.google_sub and i.provider = 'google'
        where i.user_id = c.user_id))
    order by c.dirty desc, c.synced_at nulls first
    limit how_many
    for update of c skip locked
  ), claimed as (
    update public.google_copies c set locked_until = now() + interval '2 minutes', dirty = false
    from picked p where c.list_id = p.list_id and c.user_id = p.user_id
    returning c.*
  )
  select c.list_id, c.user_id, c.tasklist, c.state, c.title_seen, c.pulled_to, c.order_seen,
         (select i.provider_id from auth.identities i where i.user_id = c.user_id and i.provider = 'google' limit 1)
  from claimed c;
end;
$$;

-- Saves a sync's changes to the shared list in one go, as the member whose Google list
-- they came from. Each row has all of a task's fields; a new id makes a new task.
-- Returns each task's id and its new updated time.
create function public.apply_copy_changes(l uuid, u uuid, rows jsonb)
returns table (id text, updated timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform set_config('tabandtick.by', u::text, true);
  perform set_config('tabandtick.copy', u::text, true);
  return query
  insert into public.tasks as t (list_id, id, parent, title, notes, due, status, completed, position, deleted_at)
  select l, r.id, r.parent, coalesce(r.title, ''), r.notes, r.due, coalesce(r.status, 'needsAction'), r.completed, coalesce(r.position, '5'), r.deleted_at
  from jsonb_to_recordset(rows) as r (id text, parent text, title text, notes text, due text, status text, completed text, position text, deleted_at timestamptz)
  on conflict (list_id, id) do update set
    parent = excluded.parent, title = excluded.title, notes = excluded.notes, due = excluded.due,
    status = excluded.status, completed = excluded.completed, position = excluded.position, deleted_at = excluded.deleted_at
  returning t.id, t.updated;
end;
$$;

-- Renames the shared list, as the member whose Google list was renamed.
create function public.rename_from_copy(l uuid, u uuid, title text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform set_config('tabandtick.copy', u::text, true);
  update public.lists set title = rename_from_copy.title where id = l;
end;
$$;

-- A member's Google account ID, for their kept token
create function public.google_sub_of(u uuid) returns text
language sql stable security definer set search_path = '' as $$
  select provider_id from auth.identities where user_id = u and provider = 'google' limit 1;
$$;

revoke all on function public.copies_key(), public.wake_copies(uuid[]), public.google_sub_of(uuid), public.claim_copies(uuid, uuid, boolean, integer),
  public.apply_copy_changes(uuid, uuid, jsonb), public.rename_from_copy(uuid, uuid, text),
  public.copy_for_member(), public.uncopy_member(), public.queue_copy_removal(),
  public.copies_behind(), public.copies_renamed(), public.copy_made() from public, anon, authenticated;
grant execute on function public.copies_key(), public.google_sub_of(uuid), public.claim_copies(uuid, uuid, boolean, integer),
  public.apply_copy_changes(uuid, uuid, jsonb), public.rename_from_copy(uuid, uuid, text) to service_role;

-- ---- For people

-- Shares one of your Google lists: a shared list of that name, with your Google list as
-- your copy, so it isn't copied. Its tasks join at the first sync. Returns its id.
create function public.share_list(title text, tasklist text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare l uuid;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if tasklist is null or tasklist = '' or length(tasklist) > 200 then raise exception 'no list' using errcode = '22023'; end if;
  if exists (select 1 from public.google_copies c where c.user_id = auth.uid() and c.tasklist = share_list.tasklist) then
    select c.list_id into l from public.google_copies c where c.user_id = auth.uid() and c.tasklist = share_list.tasklist;
    return l; -- shared already
  end if;
  insert into public.lists (title, owner) values (coalesce(share_list.title, ''), auth.uid()) returning id into l;
  update public.google_copies c set tasklist = share_list.tasklist, title_seen = share_list.title
  where c.list_id = l and c.user_id = auth.uid();
  return l;
end;
$$;

-- Your copy again, after deleting it in Google
create function public.add_back(l uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.google_copies set wanted = true, state = 'new', tasklist = null, title_seen = null,
    pulled_to = null, order_seen = null, dirty = true, next_try = null, error = null
  where list_id = l and user_id = auth.uid() and not wanted;
  if found then perform public.wake_copies(array[l]); end if;
end;
$$;

revoke all on function public.share_list(text, text), public.add_back(uuid) from public, anon;
grant execute on function public.share_list(text, text), public.add_back(uuid) to authenticated;
