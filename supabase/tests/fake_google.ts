// A Google Tasks API in memory, for testing the sync (copies.ts), behaving as Google
// was seen to on 2026-11-28: positions are renumbered when anything moves, and moving
// doesn't change a task's updated time; deleting a task deletes its subtasks; clearing
// hides completed tasks; due keeps only the date; titles up to 1024 characters and notes
// up to 8192. Each token is an account. It counts requests.

import type { Answer, Google } from '../functions/_shared/copies.ts';

type Task = {
  id: string; title: string; notes?: string; due?: string; status: string; completed?: string;
  parent?: string; updated: string; deleted?: boolean; hidden?: boolean;
};
type List = { id: string; title: string; updated: string; tasks: Map<string, Task>; order: Map<string, string[]> };

export class FakeGoogle {
  accounts = new Map<string, Map<string, List>>();
  calls = 0;
  writes = 0;
  busy = 0; // answer this many requests with 429
  private clock = Date.now();
  private made = 0;

  now(): string {
    this.clock = Math.max(this.clock + 1, Date.now());
    return new Date(this.clock).toISOString();
  }

  account(token: string): Map<string, List> {
    if (!this.accounts.has(token)) this.accounts.set(token, new Map());
    return this.accounts.get(token)!;
  }

  // ---- For tests: what someone sees in Google Tasks, and changes made there

  listNamed(token: string, title: string): List | undefined {
    return [...this.account(token).values()].find((l) => l.title === title);
  }

  // Open tasks in order, as "Title" or "  Subtask", then completed ones as "x Title"
  view(token: string, listId: string): string[] {
    const list = this.account(token).get(listId);
    if (!list) return [];
    const out: string[] = [];
    for (const id of list.order.get('') || []) {
      const t = list.tasks.get(id)!;
      if (t.deleted || t.hidden || t.status === 'completed') continue;
      out.push(t.title);
      for (const k of list.order.get(id) || []) {
        const kid = list.tasks.get(k)!;
        if (!kid.deleted && !kid.hidden && kid.status !== 'completed') out.push('  ' + kid.title);
      }
    }
    const done = [...list.tasks.values()].filter((t) => !t.deleted && !t.hidden && t.status === 'completed').map((t) => 'x ' + t.title).sort();
    return out.concat(done);
  }

  find(token: string, listId: string, title: string): Task {
    const t = [...this.account(token).get(listId)!.tasks.values()].find((x) => x.title === title && !x.deleted);
    if (!t) throw new Error('no task ' + title);
    return t;
  }

  // Calls as the API would, without counting
  async as(token: string, method: string, path: string, body?: unknown): Promise<any> {
    const answer = this.handle(method, path, token, body);
    if (answer.status >= 300) throw new Error(method + ' ' + path + ' ' + answer.status + ' ' + JSON.stringify(answer.body));
    return answer.body;
  }

  // ---- The API

  google: Google = (method, path, token, body) => {
    this.calls++;
    if (method !== 'GET') this.writes++;
    if (this.busy > 0) {
      this.busy--;
      return Promise.resolve({ status: 429, body: { error: { message: 'Rate Limit Exceeded' } } });
    }
    return Promise.resolve(this.handle(method, path, token, body));
  };

  private handle(method: string, path: string, token: string, body?: any): Answer {
    if (!token.startsWith('tok-')) return { status: 401, body: { error: { message: 'Invalid Credentials' } } };
    const lists = this.account(token);
    const [route, query = ''] = path.split('?');
    const q = new URLSearchParams(query);
    const parts = route.split('/').map(decodeURIComponent);
    const answer = (status: number, value?: unknown) => ({ status, body: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
    const notFound = () => answer(404, { error: { message: 'Not Found' } });

    // users/@me/lists[/id]
    if (parts[0] === 'users') {
      const id = parts[3];
      if (!id && method === 'GET') return answer(200, { items: [...lists.values()].map(listOf) });
      if (!id && method === 'POST') {
        const list: List = { id: 'L' + ++this.made, title: body.title, updated: this.now(), tasks: new Map(), order: new Map() };
        lists.set(list.id, list);
        return answer(200, listOf(list));
      }
      const list = lists.get(id);
      if (!list) return notFound();
      if (method === 'GET') return answer(200, listOf(list));
      if (method === 'PATCH') { list.title = body.title; list.updated = this.now(); return answer(200, listOf(list)); }
      if (method === 'DELETE') { lists.delete(id); return answer(204); }
      return answer(400);
    }

    // lists/id/tasks[/id[/move]] and lists/id/clear
    const list = lists.get(parts[1]);
    if (!list) return notFound();
    if (parts[2] === 'clear') {
      for (const t of list.tasks.values()) if (t.status === 'completed' && !t.hidden) { t.hidden = true; t.updated = this.now(); }
      return answer(204);
    }
    const taskId = parts[3];
    if (!taskId && method === 'GET') {
      const showCompleted = q.get('showCompleted') !== 'false', showHidden = q.get('showHidden') === 'true', showDeleted = q.get('showDeleted') === 'true';
      const min = q.get('updatedMin');
      const all = [...list.tasks.values()].reverse() // not in order: the sync must sort
        .filter((t) => (showDeleted || !t.deleted) && (showHidden || !t.hidden) && (showCompleted || t.status !== 'completed'))
        .filter((t) => !min || t.updated >= min)
        .map((t) => this.taskOf(list, t));
      const max = Number(q.get('maxResults') || 20), from = Number(q.get('pageToken') || 0);
      const page = all.slice(from, from + max);
      return answer(200, { items: page, ...(from + max < all.length ? { nextPageToken: String(from + max) } : {}) });
    }
    if (!taskId && method === 'POST') {
      const bad = this.check(body);
      if (bad) return answer(400, { error: { message: bad } });
      const t: Task = { id: 'T' + ++this.made, title: body.title || '', status: body.status || 'needsAction', updated: this.now() };
      this.fields(t, body);
      list.tasks.set(t.id, t);
      this.place(list, t, q.get('parent') || undefined, q.get('previous') || undefined);
      return answer(200, this.taskOf(list, t));
    }
    const t = list.tasks.get(taskId);
    if (!t || (t.deleted && method !== 'GET')) return notFound();
    if (parts[4] === 'move' && method === 'POST') {
      this.unplace(list, t);
      this.place(list, t, q.get('parent') || undefined, q.get('previous') || undefined);
      return answer(200, this.taskOf(list, t)); // updated doesn't change
    }
    if (method === 'GET') return answer(200, this.taskOf(list, t));
    if (method === 'PATCH') {
      const bad = this.check(body);
      if (bad) return answer(400, { error: { message: bad } });
      this.fields(t, body);
      t.updated = this.now();
      return answer(200, this.taskOf(list, t));
    }
    if (method === 'DELETE') {
      for (const x of [t, ...[...list.tasks.values()].filter((k) => k.parent === t.id)]) {
        x.deleted = true;
        x.updated = this.now();
        this.unplace(list, x);
      }
      return answer(204);
    }
    return answer(400);
  }

  private check(body: any): string | null {
    if (body?.title && body.title.length > 1024) return 'Title is too long.';
    if (body?.notes && body.notes.length > 8192) return 'Notes are too long.';
    return null;
  }

  private fields(t: Task, body: any) {
    for (const key of ['title', 'notes', 'due', 'status', 'completed'] as const) {
      if (!(key in body)) continue;
      const value = body[key];
      if (value === null || value === '') delete (t as any)[key];
      else (t as any)[key] = key === 'due' ? value.slice(0, 10) + 'T00:00:00.000Z' : value;
    }
    if (!t.title) t.title = '';
    if (!t.status) t.status = 'needsAction';
    if (t.status === 'completed' && !t.completed) t.completed = this.now();
    if (t.status !== 'completed') delete t.completed;
  }

  // Under parent, after previous (or first, as Google does with no previous)
  private place(list: List, t: Task, parent?: string, previous?: string) {
    if (parent) t.parent = parent;
    else delete t.parent;
    const key = parent || '';
    const seq = list.order.get(key) || [];
    const at = previous ? seq.indexOf(previous) + 1 : 0;
    seq.splice(at, 0, t.id);
    list.order.set(key, seq);
  }

  private unplace(list: List, t: Task) {
    const seq = list.order.get(t.parent || '') || [];
    const at = seq.indexOf(t.id);
    if (at >= 0) seq.splice(at, 1);
  }

  private taskOf(list: List, t: Task) {
    const seq = list.order.get(t.parent || '') || [];
    const at = seq.indexOf(t.id);
    // Renumbered whenever anything moves, as Google's are
    return { kind: 'tasks#task', ...t, position: String(at < 0 ? 99999 : at).padStart(20, '0') };
  }
}

function listOf(l: List) {
  return { kind: 'tasks#taskList', id: l.id, title: l.title, updated: l.updated };
}
