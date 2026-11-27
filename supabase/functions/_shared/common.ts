// Shared by Tab & Tick's sign-in functions: which sites may call them, encrypting
// refresh tokens, talking to Google, and finding who's calling.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.49.4';

// The website, and local copies for development
const ORIGINS = [/^https:\/\/tabandtick\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const allowed = ORIGINS.some((re) => re.test(origin));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://tabandtick.github.io',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

export function reply(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json' },
  });
}

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error('Missing secret ' + name);
  return value;
}

// The service role: reaches google_tokens, which nothing else can
export function admin(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
}

// ---- Encrypting refresh tokens, with a key kept only as a function secret

async function key(): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(env('TOKEN_KEY')), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(text)));
  const both = new Uint8Array(iv.length + data.length);
  both.set(iv);
  both.set(data, iv.length);
  return btoa(String.fromCharCode(...both));
}

export async function open(sealed: string): Promise<string> {
  const both = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: both.slice(0, 12) }, await key(), both.slice(12));
  return new TextDecoder().decode(plain);
}

// ---- Google

// All Tab & Tick asks Google for. A token with more than this isn't kept: Google can
// merge in other access given to the same Google Cloud project (such as publishing to
// the Chrome Web Store), which the server mustn't hold.
export const ALLOWED = new Set([
  'openid',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/drive.file',
]);

export function extraScopes(scope?: string): string[] {
  return (scope || '').split(' ').filter((s) => s && !ALLOWED.has(s));
}

export type GoogleAnswer = {
  access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; id_token?: string;
  error?: string; error_description?: string;
};

export async function google(params: Record<string, string>): Promise<GoogleAnswer> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), ...params }),
  });
  return await response.json();
}

// Who an ID token is about. It came straight from Google's token endpoint over TLS,
// in answer to our own request, so its contents can be trusted without checking the
// signature; Supabase checks it again when the browser signs in with it.
export function whoIs(idToken: string): { sub: string; email: string } {
  const payload = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  return { sub: payload.sub, email: payload.email };
}

// The Supabase user calling, from their session, and their Google account's ID
export async function caller(req: Request, db: SupabaseClient): Promise<{ user: User; sub: string } | null> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!jwt) return null;
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) return null;
  const identity = (data.user.identities || []).find((i) => i.provider === 'google');
  const sub = identity && (identity.identity_data?.sub || identity.id);
  return sub ? { user: data.user, sub: String(sub) } : null;
}
