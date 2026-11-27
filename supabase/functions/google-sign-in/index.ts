// Logging in: the website sends the one-time code from Google's window. This swaps it
// for Google's tokens, keeps the refresh token (encrypted), and hands back the
// hour-long access token and the ID token, with which the browser signs in to Supabase.
// POST { code }  →  { access_token, expires_in, scope, id_token, kept }
import { admin, cors, extraScopes, google, reply, seal, whoIs } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return reply(req, 405, { error: 'method' });
  try {
    const { code } = await req.json();
    if (typeof code !== 'string' || !code) return reply(req, 400, { error: 'no_code' });

    // 'postmessage' is what Google's popup uses in place of a redirect address
    const answer = await google({ code, grant_type: 'authorization_code', redirect_uri: 'postmessage' });
    if (!answer.access_token || !answer.id_token) {
      return reply(req, 400, { error: answer.error || 'no_token', reason: answer.error_description || '' });
    }
    const { sub } = whoIs(answer.id_token);
    const db = admin();

    // Only ever keep access to what Tab & Tick itself asks for (see ALLOWED). A token
    // with more isn't kept, though it still works for its hour.
    const extra = extraScopes(answer.scope);
    if (extra.length) {
      console.warn('google-sign-in: not keeping a token with extra scopes', extra);
      await db.from('google_tokens').delete().eq('google_sub', sub);
      return reply(req, 200, { access_token: answer.access_token, expires_in: answer.expires_in, scope: answer.scope, id_token: answer.id_token, kept: false });
    }

    // Google gives a refresh token the first time you agree; after that, the one kept
    // from before goes on working, so only replace it when there's a new one.
    let kept = false;
    if (answer.refresh_token) {
      const { error } = await db.from('google_tokens').upsert({
        google_sub: sub, refresh_token: await seal(answer.refresh_token), scopes: answer.scope || '', last_used_at: new Date().toISOString(),
      });
      if (error) throw error;
      kept = true;
    } else {
      const { data } = await db.from('google_tokens').select('google_sub').eq('google_sub', sub).maybeSingle();
      kept = !!data;
      if (kept) await db.from('google_tokens').update({ scopes: answer.scope || '', last_used_at: new Date().toISOString() }).eq('google_sub', sub);
    }

    return reply(req, 200, {
      access_token: answer.access_token, expires_in: answer.expires_in, scope: answer.scope,
      id_token: answer.id_token, kept, // kept false: ask Google again with prompt=consent for a refresh token
    });
  } catch (error) {
    console.error('google-sign-in', error);
    return reply(req, 500, { error: 'server' });
  }
});
