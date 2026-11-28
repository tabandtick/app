-- list_people() also gives each member's user ID, so the app can say who changed a
-- task (tasks.updated_by). Still for the list's members only.
drop function public.list_people(uuid);
create function public.list_people(l uuid)
returns table (email text, name text, photo text, role text, joined boolean, user_id uuid)
language sql stable security definer set search_path = '' as $$
  select m.email,
         coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', ''),
         coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture', ''),
         m.role, m.user_id is not null, m.user_id
  from public.list_members m left join auth.users u on u.id = m.user_id
  where m.list_id = l and public.is_member(l)
  order by m.role = 'owner' desc, m.created_at;
$$;
revoke all on function public.list_people(uuid) from public, anon;
grant execute on function public.list_people(uuid) to authenticated;
