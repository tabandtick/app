// A fresh hour-long Google token for the signed-in person, from their kept refresh
// token, so the website never has to open Google's window again.
// POST, with the Supabase session as Authorization  →  { access_token, expires_in, scope }
// 401 { error: 'signed_out' } if there's no session or Google no longer honours it.
import { admin, caller, cors, extraScopes, google, later, open, reply, sessionUserId } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return reply(req, 405, { error: 'method' });
  try {
    const db = admin();
    const userId = await sessionUserId(req);
    if (!userId) return reply(req, 401, { error: 'signed_out' });

    // Usually found by the user's ID, set the first time. That first time, Supabase is
    // asked which Google account the user is, to link the two.
    let { data: row } = await db.from('google_tokens').select('google_sub, refresh_token').eq('user_id', userId).maybeSingle();
    if (!row) {
      const who = await caller(req, db);
      if (!who || who.user.id !== userId) return reply(req, 401, { error: 'signed_out' });
      ({ data: row } = await db.from('google_tokens').select('google_sub, refresh_token').eq('google_sub', who.sub).maybeSingle());
    }
    if (!row) return reply(req, 401, { error: 'signed_out' });
    const sub = row.google_sub;

    const answer = await google({ grant_type: 'refresh_token', refresh_token: await open(row.refresh_token) });
    if (answer.error === 'invalid_grant') { // revoked, or unused for six months: Google won't renew it
      await db.from('google_tokens').delete().eq('google_sub', sub);
      return reply(req, 401, { error: 'signed_out' });
    }
    if (!answer.access_token) return reply(req, 502, { error: answer.error || 'google' });
    if (extraScopes(answer.scope).length) { // more than Tab & Tick asks for: not ours to keep
      await db.from('google_tokens').delete().eq('google_sub', sub);
      return reply(req, 401, { error: 'signed_out' });
    }

    later(db.from('google_tokens').update({ user_id: userId, last_used_at: new Date().toISOString(), scopes: answer.scope || undefined })
      .eq('google_sub', sub));
    return reply(req, 200, { access_token: answer.access_token, expires_in: answer.expires_in, scope: answer.scope });
  } catch (error) {
    console.error('google-token', error);
    return reply(req, 500, { error: 'server' });
  }
});
