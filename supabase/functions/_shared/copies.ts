// Keeps shared lists matched across everyone's Google Tasks. Each member of a shared list
// has it as a normal Google Tasks list (their copy); the shared list's tasks on the
// server (the hub) are the record in the middle. A sync of one copy:
//
//   1. reads what changed in that Google list since last time, and the hub's tasks;
//   2. merges each task that changed on either side, field by field, against what the
//      two last agreed (base): one side changed a field → take it; both → the later;
//      an edit beats a delete; a new task on either side is made on the other;
//   3. matches the order (Google doesn't say when a task moves, so the order of open
//      tasks is read now and then);
//   4. saves the hub's side in one go, as the member, then changes Google to match.
//
// Google's things: a list's tasks, each with title, notes, due (a date), status,
// completed, parent (one level) and position. "Hidden" (cleared when completed) is
// taken as deleted. See supabase/migrations/…_google_copies.sql for the tables.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';

export const TITLE_MAX = 1024;
export const NOTES_MAX = 8192;
const ORDER_EVERY = 5 * 60 * 1000; // when idle, how often to read the order

// ---- Talking to Google

export type Answer = { status: number; body: any };
// One request to the Tasks API as the account the token is for. path is after /tasks/v1/.
export type Google = (method: string, path: string, token: string, body?: unknown) => Promise<Answer>;

export const google: Google = async (method, path, token, body) => {
  try {
    const response = await fetch('https://tasks.googleapis.com/tasks/v1/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: response.status, body: json };
  } catch {
    return { status: 0, body: null }; // not reached
  }
};

export class Busy extends Error {}         // Google asks us to wait, or can't be reached
export class NoPermission extends Error {} // the token's refused
class ListGone extends Error {}            // the copy was deleted in Google

function ok(answer: Answer, what: string): any {
  const { status, body } = answer;
  if (status >= 200 && status < 300) return body;
  const reason = JSON.stringify(body?.error || '');
  if (status === 401 || (status === 403 && !/rate|quota|limit/i.test(reason))) throw new NoPermission(what + ' ' + status);
  if (status === 0 || status === 429 || status >= 500 || status === 403) throw new Busy(what + ' ' + (status || 'no connection'));
  throw new Error(what + ' ' + status + ' ' + reason);
}

// ---- A task's fields, as both sides keep them

type Done = 'needsAction' | 'completed';
export type Fields = { title: string; notes: string | null; due: string | null; status: Done; completed: string | null };
export type Base = Fields & { parent: string | null; pos: string };

type Hub = {
  id: string; parent: string | null; title: string; notes: string | null; due: string | null;
  status: string; completed: string | null; position: string; updated: string; deleted_at: string | null;
};
type GTask = {
  id: string; title?: string; notes?: string; due?: string; status?: string; completed?: string;
  parent?: string; position?: string; updated?: string; deleted?: boolean; hidden?: boolean;
};
type Link = { task_id: string; google_id: string | null; base: Base };

const KEYS = ['title', 'notes', 'due', 'done'] as const;
type Key = typeof KEYS[number];

function day(due: string | null | undefined): string | null {
  return due ? due.slice(0, 10) + 'T00:00:00.000Z' : null; // Google keeps no time
}

export function cut(text: string | null, max: number): string | null {
  if (text === null || text.length <= max) return text;
  return Array.from(text).slice(0, max).join('').slice(0, max);
}

function ofHub(h: Hub): Fields {
  const done = h.status === 'completed';
  return { title: h.title || '', notes: h.notes || null, due: day(h.due), status: done ? 'completed' : 'needsAction', completed: done ? h.completed || null : null };
}

// A Google task's fields. A title or notes Google has cut short is read as the whole.
function ofGoogle(g: GTask, base?: Base): Fields {
  let title = g.title || '';
  let notes = g.notes || null;
  if (base && base.title.length > TITLE_MAX && title === cut(base.title, TITLE_MAX)) title = base.title;
  if (base && base.notes && base.notes.length > NOTES_MAX && notes === cut(base.notes, NOTES_MAX)) notes = base.notes;
  const done = g.status === 'completed';
  return { title, notes, due: day(g.due), status: done ? 'completed' : 'needsAction', completed: done ? g.completed || null : null };
}

function get(f: Fields, key: Key): string | null {
  return key === 'done' ? f.status : f[key];
}

function put(to: Fields, from: Fields, key: Key): void {
  if (key === 'done') {
    to.status = from.status;
    to.completed = from.completed;
  } else if (key === 'title') to.title = from.title;
  else to[key] = from[key];
}

function same(a: Fields, b: Fields): boolean {
  return KEYS.every((key) => get(a, key) === get(b, key));
}

function time(t: string | null | undefined): number {
  const n = t ? Date.parse(t) : NaN;
  return isNaN(n) ? 0 : n;
}

// Field by field against what both last had: a field changed on one side is taken
// from it; changed on both, the later change wins.
export function merge(base: Fields, g: Fields, gTime: string | undefined, h: Fields, hTime: string): Fields {
  const out = { ...h };
  for (const key of KEYS) {
    const gChanged = get(g, key) !== get(base, key), hChanged = get(h, key) !== get(base, key);
    if (gChanged && (!hChanged || (get(g, key) !== get(h, key) && time(gTime) > time(hTime)))) put(out, g, key);
  }
  if (out.status === 'completed' && !out.completed) out.completed = new Date().toISOString();
  return out;
}

// What Google needs to change from g to f
function patchOf(f: Fields, g: Fields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (f.title !== g.title) body.title = cut(f.title, TITLE_MAX);
  if (f.notes !== g.notes) body.notes = cut(f.notes, NOTES_MAX);
  if (f.due !== g.due) body.due = f.due;
  if (f.status !== g.status) {
    body.status = f.status;
    body.completed = f.status === 'completed' ? f.completed : null;
  }
  return body;
}

function bodyOf(f: Fields): Record<string, unknown> {
  const body: Record<string, unknown> = { title: cut(f.title, TITLE_MAX), status: f.status };
  if (f.notes) body.notes = cut(f.notes, NOTES_MAX);
  if (f.due) body.due = f.due;
  if (f.status === 'completed' && f.completed) body.completed = f.completed;
  return body;
}

// ---- Order

// A string of digits that sorts after a and before b (or anywhere after a when b is
// null), as shared.js's between(), so the app and the sync place tasks alike.
export function between(a: string | null, b: string | null): string {
  a = a || '';
  if (b !== null && b !== undefined && b <= a) b = null;
  let out = '';
  for (let i = 0; ; i++) {
    const x = i < a.length ? +a.charAt(i) : 0;
    const y = b === null || b === undefined ? 10 : i < b.length ? +b.charAt(i) : 0;
    if (y - x > 1) return out + Math.floor((x + y) / 2);
    out += x;
    if (y - x === 1) b = null;
  }
}

// Which of these, in this order, can stay where they are: the longest run whose ranks
// go up. The others moved.
export function staying(ranks: number[]): boolean[] {
  const tails: number[] = [], prev = new Array(ranks.length).fill(-1);
  for (let i = 0; i < ranks.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ranks[tails[mid]] < ranks[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Array(ranks.length).fill(false);
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out[i] = true;
  return out;
}

function byPlace(a: { pos: string; id: string }, b: { pos: string; id: string }): number {
  return a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function newId(): string {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- One copy

export type Copy = {
  list_id: string; user_id: string; tasklist: string | null; state: string;
  title_seen: string | null; pulled_to: string | null; order_seen: string | null; google_sub: string | null;
};

export type Deps = {
  db: SupabaseClient;
  google: Google;
  token: (sub: string) => Promise<string | null>; // a Google token for that account, or null if none
  forgetToken?: (sub: string) => Promise<void>;     // the token was refused
};

export type Outcome = { state: string; tasklist: string | null; calls: number };

// Syncs a claimed copy, and lets go of it. asked: someone's waiting (read the order).
export async function syncCopy(d: Deps, c: Copy, asked = false): Promise<Outcome> {
  const db = d.db;
  let calls = 0;
  const done = (fields: Record<string, unknown>) =>
    db.from('google_copies').update({ ...fields, locked_until: null }).eq('list_id', c.list_id).eq('user_id', c.user_id);
  const token = c.google_sub ? await d.token(c.google_sub) : null;
  if (!token) {
    await done({ state: 'needs_permission', error: null });
    return { state: 'needs_permission', tasklist: c.tasklist, calls };
  }
  const g = async (method: string, path: string, body?: unknown) => {
    calls++;
    return await d.google(method, path, token, body);
  };
  try {
    const result = await sync(d, c, g, asked);
    await done({ ...result, state: 'on', error: null, next_try: null, synced_at: new Date().toISOString() });
    return { state: 'on', tasklist: result.tasklist, calls };
  } catch (error) {
    if (error instanceof ListGone) { // they deleted it in Google: they no longer want it
      await db.from('google_copy_tasks').delete().eq('list_id', c.list_id).eq('user_id', c.user_id);
      await done({ wanted: false, state: 'off', tasklist: null, title_seen: null, pulled_to: null, order_seen: null, error: null });
      return { state: 'off', tasklist: null, calls };
    }
    if (error instanceof NoPermission) {
      if (d.forgetToken && c.google_sub) await d.forgetToken(c.google_sub);
      await done({ dirty: true, error: String(error.message), next_try: new Date(Date.now() + 60000).toISOString() });
      return { state: c.state, tasklist: c.tasklist, calls };
    }
    const wait = error instanceof Busy ? 2 : 5;
    if (error instanceof Busy) console.warn('google-copies: busy', c.list_id, (error as Error).message);
    else console.error('google-copies', c.list_id, c.user_id, error);
    await done({ dirty: true, error: String((error as Error).message || error).slice(0, 500), next_try: new Date(Date.now() + wait * 60000).toISOString() });
    return { state: 'error', tasklist: c.tasklist, calls };
  }
}

type G = (method: string, path: string, body?: unknown) => Promise<Answer>;
const enc = encodeURIComponent;

async function readTasks(g: G, tasklist: string, query: string): Promise<GTask[]> {
  const out: GTask[] = [];
  let page = '';
  do {
    const answer = await g('GET', `lists/${enc(tasklist)}/tasks?maxResults=100&${query}${page ? '&pageToken=' + enc(page) : ''}`);
    if (answer.status === 404) throw new ListGone();
    const body = ok(answer, 'read tasks');
    out.push(...(body?.items || []));
    page = body?.nextPageToken || '';
  } while (page);
  return out;
}

async function sync(d: Deps, c: Copy, g: G, asked: boolean) {
  const db = d.db, now = new Date().toISOString();

  // ---- The list, and its name
  const { data: list, error: listError } = await db.from('lists').select('title').eq('id', c.list_id).maybeSingle();
  if (listError) throw listError;
  if (!list) throw new Error('no list'); // deleted meanwhile: its copies are being removed
  let tasklist = c.tasklist, title = list.title || '';
  let made = false;
  if (!tasklist) {
    tasklist = ok(await g('POST', 'users/@me/lists', { title: cut(title, TITLE_MAX) }), 'make list').id as string;
    made = true;
    // Saved at once, so a run that stops here doesn't make another
    await db.from('google_copies').update({ tasklist, title_seen: title }).eq('list_id', c.list_id).eq('user_id', c.user_id);
  } else {
    const answer = await g('GET', `users/@me/lists/${enc(tasklist)}`);
    if (answer.status === 404) throw new ListGone();
    const gTitle: string = ok(answer, 'read list').title || '';
    const seen = c.title_seen ?? title;
    if (gTitle !== seen && title === seen) { // renamed in Google
      const { error } = await db.rpc('rename_from_copy', { l: c.list_id, u: c.user_id, title: gTitle });
      if (error) throw error;
      title = gTitle;
    } else if (gTitle !== cut(title, TITLE_MAX)) { // renamed here (this wins if both)
      ok(await g('PATCH', `users/@me/lists/${enc(tasklist)}`, { title: cut(title, TITLE_MAX) }), 'rename list');
    }
  }

  // ---- Both sides
  const [hubAnswer, linkAnswer] = await Promise.all([
    db.from('tasks').select('id,parent,title,notes,due,status,completed,position,updated,deleted_at').eq('list_id', c.list_id).limit(10000),
    db.from('google_copy_tasks').select('task_id,google_id,base').eq('list_id', c.list_id).eq('user_id', c.user_id).limit(10000),
  ]);
  if (hubAnswer.error) throw hubAnswer.error;
  if (linkAnswer.error) throw linkAnswer.error;
  const hub = new Map<string, Hub>((hubAnswer.data as Hub[]).map((h) => [h.id, h]));
  const links = new Map<string, Link>((linkAnswer.data as Link[]).map((l) => [l.task_id, l]));
  const fresh = !links.size && !c.pulled_to; // first time: everything in Google is new
  const changed: GTask[] = made ? [] : fresh
    ? await readTasks(g, tasklist, 'showCompleted=true')
    : await readTasks(g, tasklist, 'showCompleted=true&showHidden=true&showDeleted=true&updatedMin=' + enc(new Date(time(c.pulled_to) - 2000).toISOString()));
  let pulledTo = c.pulled_to;
  for (const t of changed) if (t.updated && (!pulledTo || time(t.updated) > time(pulledTo))) pulledTo = t.updated;

  // ---- Merging, in memory first
  const byGoogle = new Map<string, Link>();
  for (const l of links.values()) if (l.google_id) byGoogle.set(l.google_id, l);
  const write = new Map<string, Hub>();     // hub rows to save
  const patches = new Map<string, Record<string, unknown>>(); // google id → changes
  const deletes = new Set<string>();         // google ids
  const unlink = new Set<string>();          // task ids no longer linked
  const handled = new Set<string>();         // task ids seen to
  const fromGoogle = new Map<string, string>(); // google id → new hub id
  const setHub = (h: Hub) => { hub.set(h.id, h); write.set(h.id, h); };
  let googleChanged = false; // really, not just seen again

  function settle(l: Link, t: GTask | null, h: Hub | undefined) {
    handled.add(l.task_id);
    const base = l.base;
    const gGone = !!t && !!(t.deleted || t.hidden);
    const gf = t ? ofGoogle(t, base) : base;
    if (gGone) googleChanged = true;
    if (!h) { // gone from the hub altogether (deleted over 30 days ago)
      if (!gGone && l.google_id) deletes.add(l.google_id);
      unlink.add(l.task_id);
      return;
    }
    const hf = ofHub(h), hGone = !!h.deleted_at;
    const gChanged = !same(gf, base), hChanged = !same(hf, base);
    if (gChanged || gGone) googleChanged = true;
    if (gGone && hGone) return unlink.add(l.task_id);
    if (gGone) {
      if (hChanged) { // an edit beats a delete: make it again in Google
        links.set(l.task_id, { task_id: l.task_id, google_id: null, base });
        return;
      }
      setHub({ ...h, deleted_at: now });
      return unlink.add(l.task_id);
    }
    if (hGone) {
      if (gChanged) { // an edit beats a delete: back in the hub
        const merged = merge(base, gf, t?.updated, base, h.updated);
        setHub({ ...h, ...merged, deleted_at: null });
        if (!same(merged, gf) && l.google_id) patches.set(l.google_id, patchOf(merged, gf));
        return;
      }
      if (l.google_id) deletes.add(l.google_id);
      return unlink.add(l.task_id);
    }
    const merged = merge(base, gf, t?.updated, hf, h.updated);
    if (!same(merged, hf)) setHub({ ...h, ...merged });
    if (!same(merged, gf) && l.google_id) patches.set(l.google_id, patchOf(merged, gf));
  }

  // What changed in Google: parents first, so new subtasks find them
  changed.sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0));
  for (const t of changed) {
    let l = byGoogle.get(t.id);
    if (!l && !(t.deleted || t.hidden)) {
      // One being made in Google when a run stopped: known by its title
      l = [...links.values()].find((x) => x.google_id === null && !handled.has(x.task_id) && hub.get(x.task_id)?.title === (t.title || ''));
      if (l) {
        l.google_id = t.id;
        byGoogle.set(t.id, l);
      }
    }
    if (l) {
      settle(l, t, hub.get(l.task_id));
      continue;
    }
    if (t.deleted || t.hidden || fromGoogle.has(t.id)) continue;
    googleChanged = true;
    // New in Google: into the hub, placed below with the order
    const parent = t.parent ? byGoogle.get(t.parent)?.task_id ?? fromGoogle.get(t.parent) ?? null : null;
    const f = ofGoogle(t);
    const id = newId();
    fromGoogle.set(t.id, id);
    setHub({ id, parent, ...f, position: '', updated: t.updated || now, deleted_at: null });
    const link = { task_id: id, google_id: t.id, base: { ...f, parent, pos: '' } };
    links.set(id, link);
    byGoogle.set(t.id, link);
    handled.add(id);
  }
  // What changed only in the hub
  for (const l of [...links.values()]) {
    if (handled.has(l.task_id) || !l.google_id) continue;
    const h = hub.get(l.task_id);
    if (!h || h.deleted_at || !same(ofHub(h), l.base)) settle(l, null, h);
  }
  for (const id of unlink) links.delete(id);
  // New in the hub, or to make again: into Google, below
  const toMake = new Set<string>();
  for (const h of hub.values()) {
    if (h.deleted_at) continue;
    const l = links.get(h.id);
    if (!l) links.set(h.id, { task_id: h.id, google_id: null, base: { ...ofHub(h), parent: h.parent, pos: h.position } });
    if (!links.get(h.id)!.google_id) toMake.add(h.id);
  }

  // ---- Order. Google doesn't say when something moves, so its order is read when
  // anything changed, when someone's waiting, and every few minutes.
  const moved = (h: Hub, l: Link) => !!l.base.pos && (h.parent !== l.base.parent || h.position !== l.base.pos);
  const hubMoved = [...links.values()].some((l) => { const h = hub.get(l.task_id); return h && !h.deleted_at && moved(h, l); });
  const readOrder = !made && (fresh || asked || googleChanged || write.size > 0 || patches.size > 0 || deletes.size > 0 ||
    toMake.size > 0 || hubMoved || !c.order_seen || Date.now() - time(c.order_seen) > ORDER_EVERY);
  const open = readOrder ? await readTasks(g, tasklist, 'showCompleted=false') : [];
  const hubOf = (googleId?: string) => (googleId ? byGoogle.get(googleId)?.task_id ?? fromGoogle.get(googleId) : undefined);
  const live = (id?: string | null) => { const h = id ? hub.get(id) : undefined; return h && !h.deleted_at ? h : undefined; };

  // Google's open tasks, by parent, in its order
  const gGroups = new Map<string, string[]>();
  if (readOrder) {
    const sorted = open.filter((t) => !t.deleted && !t.hidden && !deletes.has(t.id))
      .sort((a, b) => ((a.position || '') < (b.position || '') ? -1 : (a.position || '') > (b.position || '') ? 1 : 0));
    for (const t of sorted) {
      const id = hubOf(t.id);
      if (!live(id)) continue;
      const parent = hubOf(t.parent) ?? '';
      gGroups.set(parent, [...(gGroups.get(parent) || []), id!]);
    }
    // Moved in Google, and not in the hub: placed in the hub between its new neighbours
    const groups = [...gGroups.entries()].sort((a, b) => (a[0] ? 1 : 0) - (b[0] ? 1 : 0));
    for (const [parent, seq] of groups) {
      const known = seq.filter((id) => { const l = links.get(id)!; return l.base.pos && (l.base.parent || '') === parent; });
      const order = [...known].sort((a, b) => byPlace({ pos: links.get(a)!.base.pos, id: a }, { pos: links.get(b)!.base.pos, id: b }));
      const rank = new Map(order.map((id, i) => [id, i]));
      const keep = staying(known.map((id) => rank.get(id)!));
      const still = new Set(known.filter((_, i) => keep[i]));
      for (let i = 0; i < seq.length; i++) {
        const id = seq[i], h = hub.get(id)!, l = links.get(id)!;
        if (still.has(id) || (l.base.pos && moved(h, l))) continue; // in place, or the hub's move wins
        const before = i > 0 ? hub.get(seq[i - 1])!.position : '';
        const next = seq.slice(i + 1).find((x) => still.has(x));
        const parentId = parent || null;
        if (parentId && live(parentId)?.parent) continue; // Google allows one level, as does the app
        setHub({ ...h, parent: parentId, position: between(before, next ? hub.get(next)!.position : null) });
      }
    }
  }
  // New ones from Google that weren't in its open tasks (completed): at the end
  for (const id of fromGoogle.values()) {
    const h = hub.get(id)!;
    if (h.position) continue;
    const last = [...hub.values()].filter((x) => x.id !== id && (x.parent || '') === (h.parent || '') && x.position)
      .sort((a, b) => byPlace({ pos: a.position, id: a.id }, { pos: b.position, id: b.id })).pop();
    setHub({ ...h, position: between(last ? last.position : '', null) });
  }

  // ---- Save the hub's side, as the member
  if (write.size) {
    const rows = [...write.values()].map((h) => ({
      id: h.id, parent: h.parent, title: h.title, notes: h.notes, due: h.due, status: h.status,
      completed: h.completed, position: h.position || '5', deleted_at: h.deleted_at,
    }));
    const { data, error } = await db.rpc('apply_copy_changes', { l: c.list_id, u: c.user_id, rows });
    if (error) throw error;
    for (const r of (data || []) as { id: string; updated: string }[]) { const h = hub.get(r.id); if (h) h.updated = r.updated; }
  }

  // ---- Then Google's
  for (const id of deletes) {
    const answer = await g('DELETE', `lists/${enc(tasklist)}/tasks/${enc(id)}`);
    if (answer.status !== 404 && answer.status !== 410) ok(answer, 'delete task');
  }
  for (const [id, body] of patches) {
    if (!Object.keys(body).length) continue;
    const answer = await g('PATCH', `lists/${enc(tasklist)}/tasks/${enc(id)}`, body);
    if (answer.status !== 404) ok(answer, 'change task'); // deleted meanwhile: seen next time
  }
  // Recorded before making them, so a run that stops halfway doesn't make them twice
  if (toMake.size) {
    const { error } = await db.from('google_copy_tasks').upsert([...toMake].map((id) => ({
      list_id: c.list_id, user_id: c.user_id, task_id: id, google_id: null, base: baseOf(hub.get(id)!),
    })));
    if (error) throw error;
  }

  // Hub order wins: make what's new in Google, and move what's out of place, parents first
  const googleOf = (id: string | null | undefined) => (id ? links.get(id)?.google_id ?? null : null);
  const hubGroups = new Map<string, string[]>();
  for (const h of hub.values()) {
    if (h.deleted_at || !links.has(h.id)) continue;
    if (h.status === 'completed' && !toMake.has(h.id)) continue; // order matters for open tasks
    const parent = h.parent && live(h.parent) ? h.parent : '';
    hubGroups.set(parent, [...(hubGroups.get(parent) || []), h.id]);
  }
  const groups = [...hubGroups.entries()].sort((a, b) => (a[0] ? 1 : 0) - (b[0] ? 1 : 0));
  for (const [parent, ids] of groups) {
    ids.sort((a, b) => byPlace({ pos: hub.get(a)!.position, id: a }, { pos: hub.get(b)!.position, id: b }));
    const parentGoogle = parent ? googleOf(parent) : null;
    if (parent && !parentGoogle) continue; // its parent couldn't be made: next time
    const inGoogle = readOrder ? (gGroups.get(parent) || []).filter((id) => ids.includes(id)) : [];
    const rank = new Map(ids.map((id, i) => [id, i]));
    const keep = staying(inGoogle.map((id) => rank.get(id)!));
    const placed = new Set(inGoogle.filter((_, i) => keep[i]));
    let previous: string | null = null;
    for (const id of ids) {
      const h = hub.get(id)!, l = links.get(id)!;
      const where = (parentGoogle ? 'parent=' + enc(parentGoogle) + '&' : '') + (previous ? 'previous=' + enc(previous) : '');
      if (toMake.has(id)) {
        const answer = await g('POST', `lists/${enc(tasklist)}/tasks?${where}`, bodyOf(ofHub(h)));
        l.google_id = ok(answer, 'make task').id;
      } else if (readOrder && !placed.has(id) && h.status !== 'completed' && l.google_id) {
        const answer = await g('POST', `lists/${enc(tasklist)}/tasks/${enc(l.google_id)}/move?${where}`);
        if (answer.status !== 404) ok(answer, 'move task');
      }
      if (l.google_id && h.status !== 'completed') previous = l.google_id;
    }
  }

  // ---- What both now have
  const rows: { list_id: string; user_id: string; task_id: string; google_id: string | null; base: Base }[] = [];
  for (const l of links.values()) {
    const h = live(l.task_id);
    if (!h || !l.google_id) continue;
    const base = baseOf(h);
    const old = linkAnswer.data!.find((x: Link) => x.task_id === l.task_id) as Link | undefined;
    if (!old || old.google_id !== l.google_id || JSON.stringify(old.base) !== JSON.stringify(base)) {
      rows.push({ list_id: c.list_id, user_id: c.user_id, task_id: l.task_id, google_id: l.google_id, base });
    }
  }
  const gone = (linkAnswer.data as Link[]).filter((x) => !links.has(x.task_id) || !live(x.task_id)).map((x) => x.task_id);
  if (gone.length) {
    const { error } = await db.from('google_copy_tasks').delete().eq('list_id', c.list_id).eq('user_id', c.user_id).in('task_id', gone);
    if (error) throw error;
  }
  if (rows.length) {
    const { error } = await db.from('google_copy_tasks').upsert(rows);
    if (error) throw error;
  }
  return { tasklist, title_seen: title, pulled_to: pulledTo, order_seen: readOrder ? now : c.order_seen };
}

function baseOf(h: Hub): Base {
  return { ...ofHub(h), parent: h.parent, pos: h.position };
}

// ---- Runs

type Claim = { l?: string | null; u?: string | null; only_dirty?: boolean; how_many?: number };

async function claim(db: SupabaseClient, args: Claim): Promise<Copy[]> {
  const { data, error } = await db.rpc('claim_copies', args);
  if (error) throw error;
  return (data || []) as Copy[];
}

// Syncs one copy, and again while it changed meanwhile.
async function syncAgain(d: Deps, c: Copy, asked: boolean): Promise<Outcome> {
  let outcome = await syncCopy(d, c, asked);
  for (let i = 0; i < 3 && outcome.state === 'on'; i++) {
    const [again] = await claim(d.db, { l: c.list_id, u: c.user_id, only_dirty: true });
    if (!again) break;
    outcome = await syncCopy(d, again);
  }
  return outcome;
}

// Someone's own copy of a list, now: waits a few seconds if another run has it.
export async function syncMine(d: Deps, list: string, user: string): Promise<Outcome | null> {
  for (let i = 0; i < 25; i++) {
    const [c] = await claim(d.db, { l: list, u: user });
    if (c) return await syncAgain(d, c, true);
    const { data } = await d.db.from('google_copies').select('wanted,state,tasklist,locked_until').eq('list_id', list).eq('user_id', user).maybeSingle();
    if (!data) return null; // not in that list
    if (!data.wanted) return { state: data.state, tasklist: data.tasklist, calls: 0 };
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { state: 'busy', tasklist: null, calls: 0 };
}

// The copies of these lists that are behind, or (lists null) any that are due, and
// Google lists waiting to be deleted. A few at a time.
export async function syncDue(d: Deps, lists: string[] | null): Promise<number> {
  const copies: Copy[] = [];
  if (lists) for (const l of lists) copies.push(...await claim(d.db, { l, only_dirty: true }));
  else copies.push(...await claim(d.db, { how_many: 50 }));
  let next = 0;
  const worker = async () => { while (next < copies.length) await syncAgain(d, copies[next++], false); };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (!lists) await removeCopies(d);
  return copies.length;
}

export async function removeCopies(d: Deps): Promise<void> {
  const { data } = await d.db.from('google_copies_to_remove').select('id,user_id,tasklist').order('id').limit(20);
  for (const r of (data || []) as { id: number; user_id: string; tasklist: string }[]) {
    const { data: sub } = await d.db.rpc('google_sub_of', { u: r.user_id });
    const token = sub ? await d.token(sub as string) : null;
    if (!token) continue; // tried again later, for a week
    const answer = await d.google('DELETE', `users/@me/lists/${enc(r.tasklist)}`, token);
    if (answer.status === 204 || answer.status === 200 || answer.status === 404) {
      await d.db.from('google_copies_to_remove').delete().eq('id', r.id);
    }
  }
}
