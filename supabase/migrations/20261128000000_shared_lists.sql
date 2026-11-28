-- Shared lists, kept here so everyone in a list sees changes at once. Personal lists
-- stay in Google Tasks and never come here.
--
-- Who can see what: a list, its tasks and its people are visible only to its members.
-- Someone is invited by email; they become a member (their user ID is filled in) the
-- first time they open Tab & Tick with the Google account for that email: see
-- join_lists(). Until then the invite gives nothing.

create table public.lists (
  id         uuid primary key default gen_random_uuid(),
  title      text not null default '' check (length(title) <= 1024),
  owner      uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.list_members (
  list_id    uuid not null references public.lists on delete cascade,
  email      text not null check (email = lower(email) and length(email) <= 320),
  user_id    uuid references auth.users on delete cascade, -- null until they join
  role       text not null default 'editor' check (role in ('owner', 'editor')),
  invited_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now(),
  primary key (list_id, email)
);
create index list_members_user on public.list_members (user_id);
create index list_members_email on public.list_members (email) where user_id is null;

-- A task, with the fields Google Tasks has, so the app can treat it as one. Its ID is
-- made by the app. Deleting one only marks it, so everyone hears of it and undo works;
-- marked ones go after 30 days.
create table public.tasks (
  list_id    uuid not null references public.lists on delete cascade,
  id         text not null check (length(id) <= 64),
  parent     text check (length(parent) <= 64),
  title      text not null default '' check (length(title) <= 8192),
  notes      text check (length(notes) <= 8192),
  due        text check (length(due) <= 40),
  status     text not null default 'needsAction' check (status in ('needsAction', 'completed')),
  completed  text check (length(completed) <= 40),
  position   text not null default '5' check (length(position) <= 200),
  updated    timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users on delete set null,
  deleted_at timestamptz,
  primary key (list_id, id)
);

-- ---- Who's in a list

-- Security definer, so the rules below can ask without going round in circles.
create function public.is_member(l uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.list_members m where m.list_id = l and m.user_id = auth.uid());
$$;

create function public.is_owner(l uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lists x where x.id = l and x.owner = auth.uid());
$$;

-- Turns invites to your Google account's email into membership. Only an email Google
-- has verified counts, and only through a Google sign-in, so nobody can claim someone
-- else's invite. Returns how many lists were joined.
create function public.join_lists() returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare joined integer;
begin
  if auth.uid() is null then return 0; end if;
  update public.list_members m set user_id = auth.uid()
  where m.user_id is null and m.email in (
    select lower(i.identity_data->>'email') from auth.identities i
    where i.user_id = auth.uid() and i.provider = 'google'
      and coalesce((i.identity_data->>'email_verified')::boolean, false)
  );
  get diagnostics joined = row_count;
  return joined;
end;
$$;

-- A list's people, with their names and Google pictures, for its members only.
create function public.list_people(l uuid)
returns table (email text, name text, photo text, role text, joined boolean)
language sql stable security definer set search_path = '' as $$
  select m.email,
         coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', ''),
         coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture', ''),
         m.role, m.user_id is not null
  from public.list_members m left join auth.users u on u.id = m.user_id
  where m.list_id = l and public.is_member(l)
  order by m.role = 'owner' desc, m.created_at;
$$;

-- Whoever makes a list is its owner, and its first member.
create function public.add_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.list_members (list_id, email, user_id, role, invited_by)
  values (new.id, lower(coalesce(auth.jwt()->>'email', new.owner::text)), new.owner, 'owner', new.owner);
  return new;
end;
$$;
create trigger add_owner after insert on public.lists for each row execute function public.add_owner();

-- The server says when a task changed, and who changed it, so clocks don't matter.
create function public.touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'tasks' then
    new.updated := now();
    new.updated_by := auth.uid();
    if tg_op = 'UPDATE' then new.list_id := old.list_id; new.id := old.id; end if;
  else
    new.updated_at := now();
    if tg_op = 'UPDATE' then new.owner := old.owner; new.created_at := old.created_at; end if;
  end if;
  return new;
end;
$$;
create trigger touch before insert or update on public.tasks for each row execute function public.touch();
create trigger touch before update on public.lists for each row execute function public.touch();

-- ---- The rules

alter table public.lists enable row level security;
alter table public.list_members enable row level security;
alter table public.tasks enable row level security;

revoke all on public.lists, public.list_members, public.tasks from anon, authenticated;
grant select, insert, delete on public.lists to authenticated;
grant update (title) on public.lists to authenticated;
grant select, insert, delete on public.list_members to authenticated;
grant select, insert on public.tasks to authenticated;
grant update (parent, title, notes, due, status, completed, position, deleted_at) on public.tasks to authenticated;
grant all on public.lists, public.list_members, public.tasks to service_role;

revoke all on function public.is_member(uuid), public.is_owner(uuid), public.join_lists(),
  public.list_people(uuid), public.add_owner(), public.touch() from public, anon;
grant execute on function public.is_member(uuid), public.is_owner(uuid), public.join_lists(),
  public.list_people(uuid) to authenticated;

create policy "members see lists" on public.lists for select to authenticated
  using (public.is_member(id) or owner = auth.uid());
create policy "anyone makes their own" on public.lists for insert to authenticated
  with check (owner = auth.uid());
create policy "members rename" on public.lists for update to authenticated
  using (public.is_member(id)) with check (public.is_member(id));
create policy "owner deletes" on public.lists for delete to authenticated
  using (owner = auth.uid());

create policy "members see members" on public.list_members for select to authenticated
  using (public.is_member(list_id));
create policy "members invite" on public.list_members for insert to authenticated
  with check (public.is_member(list_id) and role = 'editor' and user_id is null and invited_by = auth.uid());
-- The owner removes anyone else; anyone else can leave.
create policy "owner removes, others leave" on public.list_members for delete to authenticated
  using (role <> 'owner' and (public.is_owner(list_id) or user_id = auth.uid()));

create policy "members see tasks" on public.tasks for select to authenticated
  using (public.is_member(list_id));
create policy "members add tasks" on public.tasks for insert to authenticated
  with check (public.is_member(list_id));
create policy "members change tasks" on public.tasks for update to authenticated
  using (public.is_member(list_id)) with check (public.is_member(list_id));

create index tasks_list on public.tasks (list_id, updated);

-- Everyone in a list hears of changes as they happen. Realtime applies the rules
-- above, so nobody hears of a list they're not in. Not list_members: Realtime can't
-- check who may hear of a deleted row, and would tell everyone the email in it.
-- Who's in which list is fetched instead.
alter publication supabase_realtime add table public.lists, public.tasks;

-- Deleted tasks go after 30 days. Daily at 03:10.
select cron.schedule(
  'delete-old-deleted-tasks',
  '10 3 * * *',
  $$delete from public.tasks where deleted_at < now() - interval '30 days'$$
);
