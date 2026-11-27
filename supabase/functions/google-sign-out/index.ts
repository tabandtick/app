// Logging out: forgets the refresh token. It isn't cancelled at Google, as that would
// also cancel other access given to the same Google Cloud project (such as publishing
// to the Chrome Web Store). Anyone can remove Tab & Tick at myaccount.google.com.
// POST, with the Supabase session as Authorization  →  { ok: true }
import { admin, caller, cors, reply } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return reply(req, 405, { error: 'method' });
  try {
    const db = admin();
    const who = await caller(req, db);
    if (!who) return reply(req, 200, { ok: true }); // nothing kept for them

    await db.from('google_tokens').delete().eq('google_sub', who.sub);
    return reply(req, 200, { ok: true });
  } catch (error) {
    console.error('google-sign-out', error);
    return reply(req, 500, { error: 'server' });
  }
});
