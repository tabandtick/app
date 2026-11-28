// The sync between shared lists and everyone's Google Tasks (functions/_shared/copies.ts),
// against the local database and a Google Tasks in memory (fake_google.ts).
// Needs the local server (supabase start); run from the app folder:
//   deno test -A supabase/tests/copies.test.ts

import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { FakeGoogle } from './fake_google.ts';
import { between, type Deps, staying, syncDue, syncMine } from '../functions/_shared/copies.ts';

const status = JSON.parse(new TextDecoder().decode((await new Deno.Command('supabase', { args: ['status', '-o', 'json'], stderr: 'null' }).output()).stdout));
const db = createClient(status.API_URL, status.SECRET_KEY || status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ALEX = 'c0000000-0000-0000-0000-000000000001', SAM = 'c0000000-0000-0000-0000-000000000002', PAT = 'c0000000-0000-0000-0000-000000000003';
const A = 'tok-g-alex', S = 'tok-g-sam', P = 'tok-g-pat';
const names: Record<string, string> = { [ALEX]: 'alex', [SAM]: 'sam', [PAT]: 'pat' };

async function sql(query: string): Promise<string> {
  const out = await new Deno.Command('docker', {
    args: ['exec', '-i', 'supabase_db_tabandtick', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', query],
    stdout: 'piped', stderr: 'piped',
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim();
}

// As a signed-in person, as Tab & Tick would be
function as(user: string, query: string): Promise<string> {
  return sql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${user}","role":"authenticated"}'; ${query}; commit;`);
}

async function reset() {
  await sql(`delete from auth.users where id in ('${ALEX}', '${SAM}', '${PAT}')`);
  for (const id of [ALEX, SAM, PAT]) {
    await sql(`insert into auth.users (id, email, aud, role) values ('${id}', '${names[id]}@example.com', 'authenticated', 'authenticated');
      insert into auth.identities (provider_id, user_id, identity_data, provider) values ('g-${names[id]}', '${id}', '{"email":"${names[id]}@example.com","email_verified":true}', 'google')`);
  }
}

async function join(list: string, user: string) {
  await sql(`insert into public.list_members (list_id, email, user_id) values ('${list}', '${names[user]}@example.com', '${user}')`);
}

// The shared list as Tab & Tick shows it: open tasks in order, subtasks indented,
// then completed ones
async function hubView(list: string): Promise<string[]> {
  const rows = JSON.parse(await sql(`select coalesce(json_agg(t), '[]') from (select id, parent, title, status, position from public.tasks
    where list_id = '${list}' and deleted_at is null order by position, id) t`)) as { id: string; parent: string | null; title: string; status: string }[];
  const out: string[] = [];
  for (const t of rows.filter((r) => !r.parent && r.status !== 'completed')) {
    out.push(t.title);
    for (const k of rows.filter((r) => r.parent === t.id && r.status !== 'completed')) out.push('  ' + k.title);
  }
  return out.concat(rows.filter((r) => r.status === 'completed').map((r) => 'x ' + r.title).sort());
}

async function copyOf(list: string, user: string) {
  return JSON.parse(await sql(`select row_to_json(c) from public.google_copies c where list_id = '${list}' and user_id = '${user}'`) || 'null');
}

Deno.test('between() places tasks as shared.js does', async () => {
  const source = await Deno.readTextFile(new URL('../../shared.js', import.meta.url));
  const body = source.match(/function between\(a, b\) \{[\s\S]*?\n  \}\n/)![0];
  const app = new Function(body + '; return between;')() as (a: string, b: string | null) => string;
  const samples = ['', '5', '25', '5', '55', '505', '9', '91', '1', '15', '45', '75', '0001'];
  for (const a of samples) for (const b of [...samples, null]) assertEquals(between(a, b), app(a, b), `between(${a}, ${b})`);
});

Deno.test('staying() keeps the longest run in order', () => {
  assertEquals(staying([1, 0, 2]).filter(Boolean).length, 2); // B moved to the top, or A below it: the same
  assertEquals(staying([1, 2, 3, 0]), [true, true, true, false]);
  assertEquals(staying([0, 1, 2]), [true, true, true]);
  assertEquals(staying([2, 0, 1]), [false, true, true]);
});

Deno.test('shared lists are everyone\'s Google Tasks lists, kept in sync', async (t) => {
  await reset();
  const fake = new FakeGoogle();
  const noToken = new Set<string>(['g-pat']);
  const d: Deps = { db, google: fake.google, token: (sub) => Promise.resolve(noToken.has(sub) ? null : 'tok-' + sub) };
  const sync = async (user: string) => {
    const r = await syncMine(d, list, user);
    assert(r, 'synced');
    return r!;
  };
  const writesDuring = async (work: () => Promise<unknown>) => {
    const before = fake.writes;
    await work();
    return fake.writes - before;
  };

  // Alex's Google list, before it's shared
  const shop = await fake.as(A, 'POST', 'users/@me/lists', { title: 'Shopping' });
  const milk = await fake.as(A, 'POST', `lists/${shop.id}/tasks`, { title: 'Milk' });
  const bread = await fake.as(A, 'POST', `lists/${shop.id}/tasks?previous=${milk.id}`, { title: 'Bread' });
  await fake.as(A, 'POST', `lists/${shop.id}/tasks?parent=${bread.id}`, { title: 'Wholemeal' });
  await fake.as(A, 'POST', `lists/${shop.id}/tasks?previous=${bread.id}`, { title: 'Eggs', status: 'completed' });
  let list = '', samList = '';

  await t.step('sharing a Google list brings its tasks in, without copying the list', async () => {
    list = await as(ALEX, `select public.share_list('Shopping', '${shop.id}')`);
    const r = await sync(ALEX);
    assertEquals([r.state, r.tasklist], ['on', shop.id]);
    assertEquals(await hubView(list), ['Milk', 'Bread', '  Wholemeal', 'x Eggs']);
    assertEquals(fake.account(A).size, 1);
  });

  await t.step('joining makes the list in your Google Tasks', async () => {
    await join(list, SAM);
    samList = (await sync(SAM)).tasklist!;
    assertEquals(fake.view(S, samList), ['Milk', 'Bread', '  Wholemeal', 'x Eggs']);
    assertEquals(fake.account(S).get(samList)!.title, 'Shopping');
  });

  await t.step('syncing again changes nothing', async () => {
    assertEquals(await writesDuring(() => sync(ALEX)), 0);
    assertEquals(await writesDuring(() => sync(SAM)), 0);
    assertEquals(await writesDuring(() => sync(ALEX)), 0);
  });

  await t.step('a change in one Google list reaches the other, as its maker\'s', async () => {
    await fake.as(S, 'PATCH', `lists/${samList}/tasks/${fake.find(S, samList, 'Milk').id}`, { status: 'completed' });
    await fake.as(S, 'POST', `lists/${samList}/tasks`, { title: 'Butter' });
    await sync(SAM);
    assertEquals(await hubView(list), ['Butter', 'Bread', '  Wholemeal', 'x Eggs', 'x Milk']);
    assertEquals(await sql(`select updated_by from public.tasks where list_id = '${list}' and title = 'Butter'`), SAM);
    await sync(ALEX);
    assertEquals(fake.view(A, shop.id), ['Butter', 'Bread', '  Wholemeal', 'x Eggs', 'x Milk']);
  });

  await t.step('a change in Tab & Tick reaches everyone\'s Google list', async () => {
    await as(SAM, `update public.tasks set title = 'Salted butter' where list_id = '${list}' and title = 'Butter'`);
    await as(SAM, `insert into public.tasks (list_id, id, title, position) values ('${list}', 'tapp1', 'Jam', '9')`);
    await sync(ALEX);
    await sync(SAM);
    assertEquals(fake.view(A, shop.id), ['Salted butter', 'Bread', '  Wholemeal', 'Jam', 'x Eggs', 'x Milk']);
    assertEquals(fake.view(S, samList), ['Salted butter', 'Bread', '  Wholemeal', 'Jam', 'x Eggs', 'x Milk']);
  });

  await t.step('both changing one task: different fields are both kept', async () => {
    await fake.as(A, 'PATCH', `lists/${shop.id}/tasks/${fake.find(A, shop.id, 'Bread').id}`, { title: 'Sourdough' });
    await fake.as(S, 'PATCH', `lists/${samList}/tasks/${fake.find(S, samList, 'Bread').id}`, { notes: 'From the bakery', due: '2026-12-01T00:00:00.000Z' });
    await sync(ALEX);
    await sync(SAM);
    await sync(ALEX);
    for (const [token, id] of [[A, shop.id], [S, samList]]) {
      const bread = fake.find(token, id, 'Sourdough');
      assertEquals([bread.notes, bread.due], ['From the bakery', '2026-12-01T00:00:00.000Z']);
    }
  });

  await t.step('both changing the same field: the later wins', async () => {
    await fake.as(A, 'PATCH', `lists/${shop.id}/tasks/${fake.find(A, shop.id, 'Jam').id}`, { title: 'Strawberry jam' });
    await sync(ALEX);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fake.as(S, 'PATCH', `lists/${samList}/tasks/${fake.find(S, samList, 'Jam').id}`, { title: 'Raspberry jam' });
    await sync(SAM);
    await sync(ALEX);
    assertEquals(fake.view(A, shop.id).includes('Raspberry jam'), true);
    assertEquals(fake.view(S, samList).includes('Raspberry jam'), true);
  });

  await t.step('an edit beats a delete', async () => {
    await fake.as(A, 'DELETE', `lists/${shop.id}/tasks/${fake.find(A, shop.id, 'Raspberry jam').id}`);
    await fake.as(S, 'PATCH', `lists/${samList}/tasks/${fake.find(S, samList, 'Raspberry jam').id}`, { notes: 'The big jar' });
    await sync(ALEX);
    await sync(SAM);
    await sync(ALEX);
    assertEquals(fake.find(A, shop.id, 'Raspberry jam').notes, 'The big jar');
    assertEquals(fake.view(S, samList).includes('Raspberry jam'), true);
  });

  await t.step('a delete reaches everyone', async () => {
    await fake.as(S, 'DELETE', `lists/${samList}/tasks/${fake.find(S, samList, 'Raspberry jam').id}`);
    await sync(SAM);
    await sync(ALEX);
    assertEquals(fake.view(A, shop.id), ['Salted butter', 'Sourdough', '  Wholemeal', 'x Eggs', 'x Milk']);
    assertEquals(await hubView(list), ['Salted butter', 'Sourdough', '  Wholemeal', 'x Eggs', 'x Milk']);
  });

  await t.step('moves in Google reach the others', async () => {
    const sour = fake.find(A, shop.id, 'Sourdough'), whole = fake.find(A, shop.id, 'Wholemeal');
    await fake.as(A, 'POST', `lists/${shop.id}/tasks/${sour.id}/move`); // to the top
    await fake.as(A, 'POST', `lists/${shop.id}/tasks/${whole.id}/move?previous=${fake.find(A, shop.id, 'Salted butter').id}`); // out, to the end
    await sync(ALEX);
    assertEquals(await hubView(list), ['Sourdough', 'Salted butter', 'Wholemeal', 'x Eggs', 'x Milk']);
    await sync(SAM);
    assertEquals(fake.view(S, samList), ['Sourdough', 'Salted butter', 'Wholemeal', 'x Eggs', 'x Milk']);
  });

  await t.step('moves in Tab & Tick reach everyone', async () => {
    const sour = await sql(`select id from public.tasks where list_id = '${list}' and title = 'Sourdough'`);
    await as(SAM, `update public.tasks set parent = '${sour}', position = '5' where list_id = '${list}' and title = 'Wholemeal'`);
    await as(SAM, `update public.tasks set position = '0001' where list_id = '${list}' and title = 'Salted butter'`);
    await sync(ALEX);
    await sync(SAM);
    for (const [token, id] of [[A, shop.id], [S, samList]]) assertEquals(fake.view(token, id), ['Salted butter', 'Sourdough', '  Wholemeal', 'x Eggs', 'x Milk']);
    assertEquals(await writesDuring(() => sync(ALEX)), 0);
  });

  await t.step('cleared completed tasks are deleted for everyone', async () => {
    await fake.as(S, 'POST', `lists/${samList}/clear`);
    await sync(SAM);
    await sync(ALEX);
    assertEquals(fake.view(A, shop.id), ['Salted butter', 'Sourdough', '  Wholemeal']);
  });

  await t.step('a rename in Google renames it for everyone', async () => {
    await fake.as(S, 'PATCH', `users/@me/lists/${samList}`, { title: 'Food' });
    await sync(SAM);
    await sync(ALEX);
    assertEquals(fake.account(A).get(shop.id)!.title, 'Food');
    assertEquals(await sql(`select title from public.lists where id = '${list}'`), 'Food');
  });

  await t.step('a title too long for Google is cut there, and stays whole here', async () => {
    const long = 'x'.repeat(1100);
    await as(ALEX, `insert into public.tasks (list_id, id, title, position) values ('${list}', 'tlong', '${long}', '95')`);
    await sync(ALEX);
    assertEquals(fake.find(A, shop.id, 'x'.repeat(1024)).title.length, 1024);
    assertEquals(await writesDuring(() => sync(ALEX)), 0);
    assertEquals((await sql(`select length(title) from public.tasks where id = 'tlong'`)), '1100');
  });

  await t.step('without permission, a copy waits', async () => {
    await join(list, PAT);
    assertEquals((await sync(PAT)).state, 'needs_permission');
  });

  await t.step('given permission, it catches up, and a third person\'s changes reach everyone', async () => {
    noToken.delete('g-pat');
    const patList = (await sync(PAT)).tasklist!;
    assertEquals(fake.view(P, patList).slice(0, 3), ['Salted butter', 'Sourdough', '  Wholemeal']);
    await fake.as(P, 'POST', `lists/${patList}/tasks`, { title: 'Apples' });
    await sync(PAT);
    await sync(ALEX);
    await sync(SAM);
    assertEquals(fake.view(A, shop.id)[0], 'Apples');
    assertEquals(fake.view(S, samList)[0], 'Apples');
  });

  await t.step('when Google is busy, it waits and tries later', async () => {
    fake.busy = 1;
    const r = await sync(SAM);
    assertEquals(r.state, 'error');
    const c = await copyOf(list, SAM);
    assert(c.next_try && c.dirty, 'tries again later');
    assertEquals((await sync(SAM)).state, 'on'); // someone asking doesn't wait
  });

  await t.step('the cron syncs copies that are behind', async () => {
    await as(SAM, `update public.tasks set title = 'Green apples' where list_id = '${list}' and title = 'Apples'`);
    await sql(`update public.google_copies set synced_at = now() where list_id = '${list}'`); // only the change makes them due
    assertEquals(await syncDue(d, null), 3); // Sam changed it in Tab & Tick, so his Google list is behind too
    assertEquals(fake.view(A, shop.id)[0], 'Green apples');
  });

  await t.step('a check when nothing changed costs two requests a list', async () => {
    await sql(`update public.google_copies set synced_at = now() - interval '2 minutes', dirty = false where list_id = '${list}'`);
    const before = fake.calls;
    assertEquals(await syncDue(d, null), 3);
    assertEquals(fake.calls - before, 6); // each: the list (for its name), and what changed
  });

  await t.step('a sync that stops halfway doesn\'t make tasks twice', async () => {
    await as(ALEX, `insert into public.tasks (list_id, id, title, position) values ('${list}', 'th1', 'Pears', '96'), ('${list}', 'th2', 'Plums', '97'), ('${list}', 'th3', 'Figs', '98')`);
    const real = fake.google;
    let made = 0;
    d.google = (method, path, token, body) => {
      if (token === S && method === 'POST' && /tasks\?/.test(path) && ++made === 2) return Promise.resolve({ status: 503, body: null });
      return real(method, path, token, body);
    };
    assertEquals((await sync(SAM)).state, 'error');
    d.google = real;
    assertEquals((await sync(SAM)).state, 'on');
    for (const title of ['Pears', 'Plums', 'Figs']) assertEquals(fake.view(S, samList).filter((x) => x === title).length, 1, title);
    assertEquals(await writesDuring(() => sync(SAM)), 0);
  });

  await t.step('deleting your copy in Google takes it out of your Google Tasks only', async () => {
    await fake.as(S, 'DELETE', `users/@me/lists/${samList}`);
    assertEquals((await sync(SAM)).state, 'off');
    assertEquals((await copyOf(list, SAM)).wanted, false);
    assertEquals(await sql(`select count(*) from public.list_members where list_id = '${list}' and user_id = '${SAM}'`), '1');
  });

  await t.step('and adding it back makes it again', async () => {
    await as(SAM, `select public.add_back('${list}')`);
    samList = (await sync(SAM)).tasklist!;
    assertEquals(fake.view(S, samList).slice(0, 4), ['Green apples', 'Salted butter', 'Sourdough', '  Wholemeal']);
  });

  await t.step('leaving deletes your Google list', async () => {
    await as(SAM, `delete from public.list_members where list_id = '${list}' and user_id = '${SAM}'`);
    await syncDue(d, null);
    assertEquals(fake.account(S).has(samList), false);
    assertEquals(fake.account(A).has(shop.id), true);
  });

  await t.step('deleting the list deletes everyone\'s', async () => {
    await as(ALEX, `delete from public.lists where id = '${list}'`);
    await syncDue(d, null);
    assertEquals(fake.account(A).size, 0);
    assertEquals(fake.account(P).size, 0);
  });

  await reset();
});
