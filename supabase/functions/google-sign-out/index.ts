// Logging out: forgets the refresh token, unless you're in a shared list, whose copy in
// your Google Tasks the server keeps up to date with it (logging out of one browser
// shouldn't stop that). { forget: true }, for forgetting the account, forgets it
// anyway. It isn't cancelled at Google, as that would also cancel other access given to
// the same Google Cloud project (such as publishing to the Chrome Web Store). Anyone can
// remove Tab & Tick at myaccount.google.com.
// POST { forget? }, with the Supabase session as Authorization  →  { ok: true, kept }
import { admin, caller, cors, reply } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return reply(req, 405, { error: 'method' });
  try {
    const db = admin();
    const who = await caller(req, db);
    if (!who) return reply(req, 200, { ok: true, kept: false }); // nothing kept for them
    const { forget } = await req.json().catch(() => ({}));

    if (!forget) {
      const { count } = await db.from('google_copies').select('list_id', { count: 'exact', head: true }).eq('user_id', who.user.id).eq('wanted', true);
      if (count) return reply(req, 200, { ok: true, kept: true });
    }
    await db.from('google_tokens').delete().eq('google_sub', who.sub);
    return reply(req, 200, { ok: true, kept: false });
  } catch (error) {
    console.error('google-sign-out', error);
    return reply(req, 500, { error: 'server' });
  }
});
