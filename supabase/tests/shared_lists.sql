-- Who can see and change shared lists: Alex makes one and invites Sam; Sam joins;
-- Eve, a stranger, must see and change nothing, and can't claim Sam's invite.
-- Run against the local database (supabase db start), which it leaves unchanged:
--   docker exec -i supabase_db_tabandtick psql -U postgres -v ON_ERROR_STOP=1 -q -o /dev/null < supabase/tests/shared_lists.sql
begin;

create function pg_temp.be(who text) returns void language plpgsql as $$
declare id uuid := case who when 'alex' then 'a0000000-0000-0000-0000-000000000001'
                            when 'sam'  then 'a0000000-0000-0000-0000-000000000002'
                            when 'eve'  then 'a0000000-0000-0000-0000-000000000003' end;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', id, 'role', 'authenticated', 'email', who || '@example.com')::text, true);
end $$;

create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', what; end if;
  raise notice 'ok: %', what;
end $$;

create function pg_temp.refused(statement text, what text) returns void language plpgsql as $$
declare n integer;
begin
  begin
    execute statement;
    get diagnostics n = row_count;
  exception when insufficient_privilege or check_violation or raise_exception then
    raise notice 'ok: %', what;
    return;
  end;
  if n > 0 then raise exception 'FAILED: %', what; end if;
  raise notice 'ok: % (nothing changed)', what;
end $$;

grant execute on all functions in schema pg_temp to authenticated;

insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('a0000000-0000-0000-0000-000000000001', 'alex@example.com', '{"full_name":"Alex","avatar_url":"https://x/alex.png"}', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-000000000002', 'sam@example.com',  '{"full_name":"Sam"}', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-000000000003', 'eve@example.com',  '{"full_name":"Eve"}', 'authenticated', 'authenticated');
-- Sam and Eve signed in with Google. Eve's Google account says sam@example.com but
-- unverified, and Eve has an email sign-in with sam@example.com too: neither counts.
insert into auth.identities (provider_id, user_id, identity_data, provider) values
  ('g-sam', 'a0000000-0000-0000-0000-000000000002', '{"email":"Sam@Example.com","email_verified":true}', 'google'),
  ('g-eve', 'a0000000-0000-0000-0000-000000000003', '{"email":"sam@example.com","email_verified":false}', 'google'),
  ('e-eve', 'a0000000-0000-0000-0000-000000000003', '{"email":"sam@example.com","email_verified":true}', 'email');

-- Alex makes a list, adds a task, invites Sam
select pg_temp.be('alex');
insert into public.lists (id, title) values ('b0000000-0000-0000-0000-000000000001', 'Shopping');
insert into public.tasks (list_id, id, title) values ('b0000000-0000-0000-0000-000000000001', 't1', 'Milk');
insert into public.list_members (list_id, email) values ('b0000000-0000-0000-0000-000000000001', 'sam@example.com');
select pg_temp.check((select count(*) from public.list_people('b0000000-0000-0000-0000-000000000001')) = 2, 'Alex sees two people');
select pg_temp.check((select role from public.list_members where email = 'alex@example.com') = 'owner', 'Alex is the owner');
select pg_temp.refused($$insert into public.lists (title, owner) values ('Fake', 'a0000000-0000-0000-0000-000000000002')$$, 'nobody makes a list for someone else');
reset role;

-- Eve can't see it, join it, change it, or claim Sam's invite
select pg_temp.be('eve');
select pg_temp.check(public.join_lists() = 0, 'Eve joins nothing with an unverified or non-Google email');
select pg_temp.check((select count(*) from public.lists) = 0, 'Eve sees no lists');
select pg_temp.check((select count(*) from public.tasks) = 0, 'Eve sees no tasks');
select pg_temp.check((select count(*) from public.list_members) = 0, 'Eve sees no members');
select pg_temp.check((select count(*) from public.list_people('b0000000-0000-0000-0000-000000000001')) = 0, 'Eve sees no people');
select pg_temp.check(not public.is_member('b0000000-0000-0000-0000-000000000001'), 'Eve isn''t a member');
select pg_temp.refused($$insert into public.tasks (list_id, id, title) values ('b0000000-0000-0000-0000-000000000001', 'e1', 'Spam')$$, 'Eve can''t add a task');
select pg_temp.refused($$update public.tasks set title = 'Hacked'$$, 'Eve can''t change a task');
select pg_temp.refused($$update public.lists set title = 'Hacked'$$, 'Eve can''t rename the list');
select pg_temp.refused($$delete from public.lists$$, 'Eve can''t delete the list');
select pg_temp.refused($$insert into public.list_members (list_id, email) values ('b0000000-0000-0000-0000-000000000001', 'eve@example.com')$$, 'Eve can''t invite herself');
select pg_temp.refused($$update public.list_members set user_id = 'a0000000-0000-0000-0000-000000000003'$$, 'Eve can''t take an invite');
select pg_temp.refused($$delete from public.list_members$$, 'Eve can''t remove anyone');
reset role;
select pg_temp.check((select title from public.tasks where id = 't1') = 'Milk', 'the task is unchanged');

-- Sam joins, and can then see and change it, but not delete it or remove Alex
select pg_temp.be('sam');
select pg_temp.check((select count(*) from public.tasks) = 0, 'Sam sees nothing before joining');
select pg_temp.check(public.join_lists() = 1, 'Sam joins the list with a verified Google email');
select pg_temp.check((select count(*) from public.tasks) = 1, 'Sam sees the task');
update public.tasks set status = 'completed' where id = 't1';
select pg_temp.check((select updated_by from public.tasks where id = 't1') = 'a0000000-0000-0000-0000-000000000002', 'the server records that Sam changed it');
select pg_temp.refused($$update public.tasks set updated_by = 'a0000000-0000-0000-0000-000000000001'$$, 'Sam can''t say Alex changed it');
select pg_temp.refused($$update public.tasks set list_id = gen_random_uuid()$$, 'Sam can''t move a task out of the list''s rules');
select pg_temp.refused($$delete from public.tasks$$, 'tasks are marked deleted, not removed');
select pg_temp.refused($$delete from public.lists$$, 'Sam can''t delete Alex''s list');
select pg_temp.refused($$delete from public.list_members where role = 'owner'$$, 'Sam can''t remove Alex');
select pg_temp.refused($$insert into public.list_members (list_id, email, role) values ('b0000000-0000-0000-0000-000000000001', 'eve@example.com', 'owner')$$, 'Sam can''t make an owner');
insert into public.list_members (list_id, email) values ('b0000000-0000-0000-0000-000000000001', 'pat@example.com');
select pg_temp.check((select count(*) from public.list_people('b0000000-0000-0000-0000-000000000001')) = 3, 'Sam invites Pat');
select pg_temp.check((select name from public.list_people('b0000000-0000-0000-0000-000000000001') where email = 'alex@example.com') = 'Alex', 'Sam sees Alex''s name');
delete from public.list_members where email = 'sam@example.com';
select pg_temp.check((select count(*) from public.tasks) = 0, 'Sam leaves, and sees nothing again');
reset role;

-- Alex removes Pat's invite, and deletes the list
select pg_temp.be('alex');
delete from public.list_members where email = 'pat@example.com';
select pg_temp.check((select count(*) from public.list_members) = 1, 'Alex removes Pat');
delete from public.lists;
reset role;
select pg_temp.check((select count(*) from public.tasks) = 0, 'deleting the list deletes its tasks');

rollback;
