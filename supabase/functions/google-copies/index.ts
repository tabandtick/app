// Keeps shared lists matched across everyone's Google Tasks: see _shared/copies.ts.
//
// POST with x-copies-key (the cron, or a trigger when a shared list changes):
//   { lists: [list ids] } syncs their copies that are behind; { lists: null } any that
//   are due, and deletes Google lists people no longer have. Answers at once (202).
// POST with a Tab & Tick session: { list } syncs your copy of that list now, and
//   answers { state, tasklist } (state: on, needs_permission, off, busy or error).
import { admin, cors, extraScopes, google as googleAuth, later, open, reply, seal, sessionUserId } from '../_shared/common.ts';
import { Busy, type Deps, google, syncDue, syncMine } from '../_shared/copies.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let key: string | null = null;

// A Google token for that account, from its kept refresh token: the last one while it
// lasts, so each sync doesn't renew it. null if there's none, or Google won't renew it.
async function tokenFor(db: SupabaseClient, sub: string): Promise<string | null> {
  const { data: row } = await db.from('google_tokens').select('refresh_token, access_token, access_until').eq('google_sub', sub).maybeSingle();
  if (!row) return null;
  if (row.access_token && row.access_until && Date.parse(row.access_until) > Date.now() + 120000) {
    try { return await open(row.access_token); } catch { /* sealed with an old key: renew */ }
  }
  const answer = await googleAuth({ grant_type: 'refresh_token', refresh_token: await open(row.refresh_token) });
  if (answer.error === 'invalid_grant' || (answer.access_token && extraScopes(answer.scope).length)) {
    await db.from('google_tokens').delete().eq('google_sub', sub); // revoked, or more than Tab & Tick's
    return null;
  }
  if (!answer.access_token) throw new Busy('google token ' + (answer.error || ''));
  if (!(answer.scope || '').split(' ').includes('https://www.googleapis.com/auth/tasks')) return null;
  await db.from('google_tokens').update({
    access_token: await seal(answer.access_token),
    access_until: new Date(Date.now() + (answer.expires_in || 3600) * 1000).toISOString(),
    last_used_at: new Date().toISOString(),
  }).eq('google_sub', sub);
  return answer.access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return reply(req, 405, { error: 'method' });
  try {
    const db = admin();
    const d: Deps = {
      db, google,
      token: (sub) => tokenFor(db, sub),
      forgetToken: async (sub) => { await db.from('google_tokens').update({ access_token: null, access_until: null }).eq('google_sub', sub); },
    };
    const body = await req.json().catch(() => ({}));

    const given = req.headers.get('x-copies-key');
    if (given) {
      if (!key) key = (await db.rpc('copies_key')).data as string | null;
      if (!key || given !== key) return reply(req, 401, { error: 'key' });
      const lists = Array.isArray(body.lists) ? body.lists.filter((l: unknown) => typeof l === 'string' && UUID.test(l)) : null;
      later(syncDue(d, lists));
      return reply(req, 202, { ok: true });
    }

    const user = await sessionUserId(req);
    if (!user) return reply(req, 401, { error: 'signed_out' });
    if (typeof body.list !== 'string' || !UUID.test(body.list)) return reply(req, 400, { error: 'list' });
    const outcome = await syncMine(d, body.list, user);
    if (!outcome) return reply(req, 404, { error: 'not_in_list' });
    return reply(req, 200, { state: outcome.state, tasklist: outcome.tasklist });
  } catch (error) {
    console.error('google-copies', error);
    return reply(req, 500, { error: 'server' });
  }
});
