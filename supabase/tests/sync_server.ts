// For tests/shared.test.mjs: Google Tasks in memory (fake_google.ts), which the test's
// pages use, and Tab & Tick's sync (functions/_shared/copies.ts) running against it and
// the local database as the server would: a person's copy when their page asks, and
// every half second any copies that are behind (as the database's trigger and cron
// would ask the real one).
//
//   deno run -A supabase/tests/sync_server.ts      prints "port <n>" when ready
//
//   /tasks/v1/...                 Google Tasks, as the person whose name is the Bearer token
//   POST /sync { list, user }     sync that person's copy now: { state, tasklist }
//   POST /permission { name, ok } whether the server has that person's permission
//   POST /google { name, method, path, body }  a change made in Google's own apps
//   GET  /view?name=&title=       that person's Google list of that name, as fake.view() has it
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { FakeGoogle } from './fake_google.ts';
import { type Deps, syncDue, syncMine } from '../functions/_shared/copies.ts';

const status = JSON.parse(new TextDecoder().decode((await new Deno.Command('supabase', { args: ['status', '-o', 'json'], stderr: 'null' }).output()).stdout));
const db = createClient(status.API_URL, status.SECRET_KEY || status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const fake = new FakeGoogle();
const refused = new Set<string>();
const d: Deps = {
  db, google: fake.google,
  token: (sub) => Promise.resolve(refused.has(sub.replace(/^g-/, '')) ? null : 'tok-' + sub),
};

let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try { await syncDue(d, null); } catch (error) { console.error('sync', error); }
  running = false;
}, 500);

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
const json = (status: number, value: unknown) => new Response(status === 204 ? null : JSON.stringify(value ?? null), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: ({ port }) => console.log('port ' + port) }, async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const url = new URL(req.url);
  if (url.pathname.startsWith('/tasks/v1/')) {
    const name = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const text = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text();
    const answer = await fake.google(req.method, url.pathname.slice('/tasks/v1/'.length) + url.search, 'tok-g-' + name, text ? JSON.parse(text) : undefined);
    return json(answer.status, answer.status === 204 ? null : answer.body);
  }
  if (url.pathname === '/sync') {
    const { list, user } = await req.json();
    const outcome = await syncMine(d, list, user);
    return outcome ? json(200, { state: outcome.state, tasklist: outcome.tasklist }) : json(404, { error: 'not_in_list' });
  }
  if (url.pathname === '/permission') {
    const { name, ok } = await req.json();
    if (ok) refused.delete(name);
    else refused.add(name);
    return json(200, { ok: true });
  }
  if (url.pathname === '/google') {
    const { name, method, path, body } = await req.json();
    return json(200, await fake.as('tok-g-' + name, method, path, body));
  }
  if (url.pathname === '/view') {
    const token = 'tok-g-' + url.searchParams.get('name');
    const list = fake.listNamed(token, url.searchParams.get('title') || '');
    return json(200, list ? { id: list.id, tasks: fake.view(token, list.id) } : null);
  }
  return json(404, { error: 'no such' });
});

await server.finished;
