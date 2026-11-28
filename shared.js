// Shared lists. Google Tasks can't share a list with another account, so each person in
// a shared list has it as a normal Google Tasks list in their own account, and Tab &
// Tick's server (Supabase) keeps them matched, through a record of the list in the
// middle: see supabase/functions/_shared/copies.ts. Here, a shared list is then just
// your Google list (linked), with people. After each change to it the server is told
// (poke), and when someone else changes it, Realtime says so: the server is asked to
// bring your Google list up to date, and it's shown again.
//
// Until your Google list is made (or if you deleted it, or the server hasn't your
// permission), the list is shown from the server instead, with the id 'cloud:' and its
// id there: send() hands its requests here, and they're answered as Google Tasks would
// answer them, from a copy kept in the page. Changes are saved straight away, in order,
// and other people's arrive through Realtime.
//
// The server decides who sees what: see supabase/migrations/…_shared_lists.sql. People
// are invited by email, and see the list once they open Tab & Tick with that account.

var shared = (function() {
  var PREFIX = 'cloud:';
  var known = {}; // by list id on the server: see entry()
  var me = null; // your user id on the server
  var db = null; // the Supabase client for the account in use
  var said = ''; // the last save problem shown, so it isn't shown again and again
  var copies = {}; // your Google lists for shared lists, by list id on the server:
                   // { tasklist, wanted, state }; state: new, on, needs_permission, off, error
  var linked = {}; // the other way: server list id by Google list id
  var started = false; // whether copies are known yet (until then, as last time)

  var self = {
    inCloud: available,
    isShared: isShared,
    isCloud: isCloud,
    withGoogle: withGoogle,
    adopt: adopt,
    poke: poke,
    annotate: annotate,
    copyOf: copyOf,
    addBack: addBack,
    hubOf: hubOf,
    visibleId: visibleId,
    request: request,
    lists: sharedLists,
    start: start,
    remove: remove,
    move: move,
    unsaved: unsaved,
    flush: function() {},
    check: check,
    link: link,
    people: people,
    who: who,
    me: function() { return me; },
    invite: invite,
    uninvite: uninvite,
    reset: reset,
    between: between
  };

  // Whether this account can keep lists here: on the website, once Tab & Tick's
  // server has a session for it.
  function available() {
    var email = currentAccount();
    return !!(window.cloud && cloud.db && email && cloud.has(email) && cloud.db(email));
  }

  function client() {
    var c = available() ? cloud.db(currentAccount()) : null;
    if (c !== db) {
      reset();
      db = c;
    }
    return db;
  }

  function reset() {
    $.each(known, function(id, f) { if (f.channel && db) db.removeChannel(f.channel); });
    known = {};
    me = null;
    db = null;
    said = '';
    copies = {};
    linked = {};
    started = false;
    $.each(poking, function(hub, p) { clearTimeout(p.timer); });
    poking = {};
  }

  // Shown from the server, as your Google list isn't there
  function isCloud(list) {
    return typeof list === 'string' && list.indexOf(PREFIX) === 0;
  }

  // Shared: from the server, or your Google list for it
  function isShared(list) {
    return isCloud(list) || !!(typeof list === 'string' && linked[list]);
  }

  // The list's id on the server, given either
  function hubOf(list) {
    if (isCloud(list)) return list.slice(PREFIX.length);
    return (typeof list === 'string' && linked[list]) || null;
  }

  // The id it's shown with: your Google list's, if you have it here
  function visibleId(hub) {
    var c = copies[hub];
    if (c && c.wanted && c.tasklist && window.findList && findList(c.tasklist)) return c.tasklist;
    return PREFIX + hub;
  }

  function copyOf(list) {
    var hub = hubOf(list);
    return hub ? $.extend({ hub: hub }, copies[hub] || {}) : null;
  }

  // ---- Your Google lists for shared lists

  function cacheKey() {
    return 'tabandtick-copies:' + currentAccount();
  }

  // As last time, so they show as shared before the server answers: { tasklist: [id, owned] }
  function cached() {
    try { return JSON.parse(localStorage.getItem(cacheKey())) || {}; } catch (e) { return {}; }
  }

  function setCopies(rows) {
    copies = {};
    $.each(rows || [], function(i, c) { copies[c.list_id] = c; });
    relink();
    started = true;
  }

  function relink() {
    linked = {};
    var keep = {};
    $.each(copies, function(hub, c) {
      if (!c.wanted || !c.tasklist) return;
      linked[c.tasklist] = hub;
      keep[c.tasklist] = [hub, !!(known[hub] && known[hub].list.owned)];
    });
    try { localStorage.setItem(cacheKey(), JSON.stringify(keep)); } catch (e) { /* storage is blocked */ }
  }

  // Your Google lists, those that are shared marked so, and the shared lists whose
  // Google list you don't have here, from the server.
  function withGoogle(googleLists) {
    var here = {}, before = started ? {} : cached(), out = [];
    $.each(googleLists, function(i, list) {
      if (list.cloud) return;
      here[list.id] = true;
      var was = before[list.id], hub = linked[list.id] || (was && was[0]), f = hub && known[hub];
      if (hub && !(f && f.gone)) {
        list.shared = true;
        list.hub = hub;
        list.canShare = true;
        list.owned = f && f.list.title ? f.list.owned : !!(was && was[1]);
      } else {
        delete list.shared; delete list.hub; delete list.canShare; delete list.owned;
      }
      out.push(list);
    });
    $.each(known, function(id, f) {
      if (f.gone || !f.list.title) return;
      var c = copies[id];
      if (c && c.wanted && c.tasklist && here[c.tasklist]) return; // shown as your Google list
      if (c && c.wanted && c.tasklist && started) poke(PREFIX + id); // gone from Google: the server checks
      out.push(f.list);
    });
    return out;
  }

  // Shares one of your Google lists: it becomes the shared list, so nothing's copied.
  function adopt(list, done, failed) {
    if (!client()) return later(failed, 401);
    whoAmI(function() {
      answer(db.rpc('share_list', { title: list.title, tasklist: list.id }), function(hub) {
        answer(db.from('lists').select('id,title,owner').eq('id', hub).single(), function(row) {
          know(row);
          copies[hub] = { list_id: hub, tasklist: list.id, wanted: true, state: 'new' };
          relink();
          poke(list.id); // its tasks join the shared list
          done();
        }, failed);
      }, failed);
    });
  }

  // Back into your Google Tasks, after you deleted it there
  function addBack(list, done, failed) {
    var hub = hubOf(list);
    if (!hub || !client()) return later(failed, 401);
    answer(db.rpc('add_back', { l: hub }), function() {
      copies[hub] = $.extend(copies[hub] || { list_id: hub }, { wanted: true, tasklist: null, state: 'new' });
      poke(PREFIX + hub);
      done();
    }, failed);
  }

  // Ask the server to bring your Google list for a shared list up to date with the
  // others, and theirs with yours: after you change it, when someone else did, and when
  // you come back to the page. A moment after the last ask; then(answer) once done.
  var poking = {}; // by server list id: { timer, running, again, thens }

  function poke(list, then) {
    var hub = hubOf(list);
    if (!hub || !window.cloud || !cloud.syncCopy || !currentAccount()) return then ? later(then, null) : null;
    var p = poking[hub] || (poking[hub] = { timer: null, running: false, again: false, thens: [] });
    if (then) p.thens.push(then);
    clearTimeout(p.timer);
    p.timer = setTimeout(function() { syncNow(hub); }, 300);
  }

  function syncNow(hub) {
    var p = poking[hub], began = session;
    if (!p) return;
    if (p.running) {
      p.again = true;
      return;
    }
    p.running = true;
    p.again = false;
    var thens = p.thens.splice(0);
    cloud.syncCopy(currentAccount(), hub, function(answer) {
      p.running = false;
      if (began !== session) return;
      if (answer) synced(hub, answer);
      $.each(thens, function(i, f) { f(answer); });
      if (p.again || p.thens.length) syncNow(hub);
    });
  }

  function synced(hub, answer) {
    var c = copies[hub] || (copies[hub] = { list_id: hub, wanted: true });
    var before = c.tasklist + ' ' + c.wanted;
    c.state = answer.state;
    if (answer.state === 'off') {
      c.wanted = false;
      c.tasklist = null;
    } else if (answer.tasklist) c.tasklist = answer.tasklist;
    relink();
    if (before !== c.tasklist + ' ' + c.wanted && window.refreshAll) refreshAll(); // its Google list was made, or deleted
    if (window.copyChanged) copyChanged(hub);
  }

  // Shared lists already shown from your Google Tasks before it was known they're
  // shared: heard from as others change them, and shown again, with who changed what
  function follow() {
    $.each(linked, function(tasklist, hub) {
      var card = cardFor(tasklist);
      if (card.length && !(known[hub] && known[hub].channel)) {
        load(hub, function() { if (card[0].loaded) reloadSoon(card); }, function() {});
      }
    });
  }

  // Shared lists whose Google list is still to be made: made now
  function makeMissing() {
    $.each(copies, function(hub, c) {
      if (c.wanted && !c.tasklist && c.state !== 'needs_permission') poke(PREFIX + hub);
    });
  }

  // Who last changed each task in your Google list for a shared list, from the server
  // (Google doesn't say): sets changedBy on the tasks Google gave, then done().
  function annotate(path, items, done) {
    var m = path.match(/^lists\/([^/?]+)\/tasks/), id = m && decodeURIComponent(m[1]), hub = id && linked[id];
    if (!hub || !client()) return done();
    load(hub, function(f) {
      answer(db.from('google_copy_tasks').select('task_id,google_id').eq('list_id', hub).eq('user_id', me).limit(10000), function(rows) {
        var byGoogle = {};
        $.each(rows || [], function(i, r) { if (r.google_id) byGoogle[r.google_id] = r.task_id; });
        $.each(items, function(i, item) {
          var t = f.tasks[byGoogle[item.id]];
          if (t && t.changedBy) item.changedBy = t.changedBy;
        });
        done();
      }, function() { done(); });
    }, function() { done(); });
  }

  function entry(id) {
    return known[id] || (known[id] = {
      id: id,
      list: { id: PREFIX + id, title: '', shared: true, cloud: true, canShare: true },
      tasks: null,    // the copy in the page, by task id
      waiting: [],    // callers waiting for it to load
      queue: [],      // changes not yet saved, in order
      saving: false,
      channel: null, live: false,
      behind: false,  // to catch up once what's waiting is saved
      stale: false,   // changed by someone else, and not yet shown
      gone: false
    });
  }

  function sharedLists() {
    return $.map(known, function(f) { return f.gone || !f.list.title ? null : f.list; });
  }

  function later(f, value) {
    if (f) setTimeout(function() { f(value); }, 0);
  }

  // A Supabase answer as done(data) or failed(status): status is undefined when the
  // server couldn't be reached, as for Google.
  function answer(query, done, failed) {
    var started = session, c = db;
    query.then(function(result) {
      if (started !== session || c !== db) return;
      if (result.error) {
        var status = result.status || undefined;
        console.info('Tab & Tick Cloud: ' + (status || 'no connection') + ' ' + (result.error.code || '') + ' ' + result.error.message);
        if (failed) failed(status, result.error.code);
      } else if (done) done(result.data);
    }, function() {
      if (started === session && c === db && failed) failed(undefined);
    });
  }

  function whoAmI(done) {
    if (me) return done(me);
    db.auth.getSession().then(function(result) {
      var s = result.data && result.data.session;
      me = s ? s.user.id : null;
      done(me);
    }, function() { done(null); });
  }

  // ---- Which lists there are

  // Join any lists shared with this account since, then ask which you have. Lists
  // gone since last time (deleted, or you were removed) go from the page.
  var tried = {}; // accounts whose quiet session was tried, in the extension

  function start(done) {
    var email = currentAccount();
    if (!available() && auth.cloudSession && email && !tried[email]) {
      tried[email] = true;
      return auth.cloudSession(email, false, function() { start(done); });
    }
    if (!client()) return later(done);
    whoAmI(function() {
      answer(db.rpc('join_lists'), next, next);
    });
    function next() {
      var left = 2, rows = null, mine = null;
      function both() {
        if (--left) return;
        if (rows) {
          var seen = {};
          $.each(rows, function(i, row) { seen[row.id] = true; know(row); });
          $.each(known, function(id, f) { if (!seen[id] && f.list.title) lost(f); });
        }
        if (mine) setCopies(mine);
        if (done) done();
        makeMissing();
        follow();
      }
      answer(db.from('lists').select('id,title,owner').order('created_at'), function(r) { rows = r || []; both(); }, both);
      answer(db.from('google_copies').select('list_id,tasklist,wanted,state').eq('user_id', me), function(r) { mine = r || []; both(); }, both);
    }
  }

  function know(row) {
    var f = entry(row.id), title = row.title || '';
    f.gone = false;
    if (f.list.title && f.list.title !== title) f.list.renamed = true;
    f.list.title = title;
    f.list.owned = row.owner === me;
    if (f.list.renamed) show(f);
    return f;
  }

  // The list's tasks, loaded once, then kept up to date. done(f), or failed(status).
  function load(id, done, failed) {
    var f = entry(id);
    if (f.tasks) return done(f);
    if (!client()) return later(failed, 401);
    f.waiting.push([done, failed]);
    if (f.waiting.length > 1) return;
    listen(f);
    // Its people too, to say who changed what; the list shows without them if need be
    var left = 2, failure = null;
    function one() {
      if (--left) return;
      $.each(f.waiting.splice(0), function(i, w) {
        if (failure === null) w[0](f);
        else if (w[1]) w[1](failure);
      });
    }
    fetchTasks(f, one, function(status) { failure = status; one(); });
    people(f.list.id, one, one);
  }

  function fetchTasks(f, done, failed) {
    answer(db.from('tasks').select('*').eq('list_id', f.id).is('deleted_at', null).limit(5000), function(rows) {
      var tasks = {};
      $.each(rows || [], function(i, row) { tasks[row.id] = taskOf(row); });
      // Changes not yet saved stay as they are here
      if (f.tasks) $.each(f.queue, function(i, op) { if (f.tasks[op.task]) tasks[op.task] = f.tasks[op.task]; else delete tasks[op.task]; });
      var changed = !f.tasks || canon(tasks) !== canon(f.tasks);
      f.tasks = tasks;
      if (changed) f.stale = true;
      done(changed);
    }, failed);
  }

  // Other people's changes, as they're made.
  function listen(f) {
    if (f.channel) return;
    f.channel = db.channel('list:' + f.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: 'list_id=eq.' + f.id }, function(change) {
        heard(f, change.new);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lists', filter: 'id=eq.' + f.id }, function(change) {
        if (change.new && change.new.title !== undefined) know(change.new);
        var shown = visibleId(f.id);
        if (!isCloud(shown)) poke(shown, function() { if (window.refreshAll) refreshAll(); }); // renamed: your Google list too
      })
      // Changes are heard only once Realtime says it's listening, which can take a
      // few seconds: then catch up on any made before, or while it was away.
      .on('system', {}, function(message) {
        if (message && message.extension === 'postgres_changes' && message.status === 'ok') {
          f.live = true;
          refresh(f);
        }
      })
      .subscribe(function(status) {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') f.live = false;
      });
  }

  function heard(f, row) {
    if (!f.tasks || !row || !row.id) return;
    // A change of ours not yet saved here wins; ours are saved in order after theirs
    if ($.grep(f.queue, function(op) { return op.task === row.id; }).length) return;
    var was = f.tasks[row.id], before = was ? JSON.stringify(was) : '';
    var shown = visibleId(f.id), theirs = row.updated_by && row.updated_by !== me;
    // Someone else's: say what they did (see heardChange in tasks.js)
    if (theirs && window.heardChange) {
      var what = !was ? (row.deleted_at ? '' : 'added') : row.deleted_at ? 'deleted' :
        was.status !== row.status ? (row.status === 'completed' ? 'ticked' : 'unticked') :
        was.title !== (row.title || '') || (was.notes || '') !== (row.notes || '') || (was.due || '') !== (row.due || '') ? 'changed' : '';
      if (what) {
        var listId = shown, user = row.updated_by, taskId = row.id, title = row.title || (was && was.title) || '';
        var tell = function() { heardChange(listId, user, taskId, what, title); };
        if (f.people && f.people[user]) tell();
        else people(listId, tell, function() {}); // someone new to this page
      }
    }
    if (row.deleted_at) delete f.tasks[row.id];
    else f.tasks[row.id] = taskOf(row);
    var after = f.tasks[row.id] ? JSON.stringify(f.tasks[row.id]) : '';
    if (before === after) return; // our own, coming back
    if (!isCloud(shown)) {
      // Shown as your Google list: once the server has brought it up to date, again
      if (theirs) poke(shown, function() { var card = cardFor(shown); if (card.length && card[0].loaded) reloadSoon(card); });
      return;
    }
    f.stale = true;
    show(f);
  }

  function reloadSoon(card) {
    if (!reload(card)) setTimeout(function() { reloadSoon(card); }, 1000); // not while you're typing in it
  }

  function refresh(f) {
    if (!f.tasks || f.gone) return;
    if (f.queue.length) {
      f.behind = true;
      return;
    }
    fetchTasks(f, function(changed) { if (changed) show(f); }, function() {});
  }

  // Show what others changed, unless that would get in the way: then try again soon.
  function show(f) {
    if (f.list.renamed) {
      f.list.renamed = false;
      showLists();
    }
    if (!f.stale) return;
    var shown = visibleId(f.id);
    if (!isCloud(shown)) { // your Google list: once the server has brought it up to date
      f.stale = false;
      var mine = cardFor(shown);
      if (mine.length && mine[0].loaded) poke(shown, function() { reloadSoon(mine); });
      return;
    }
    var card = cardFor(f.list.id);
    if (!card.length || !card[0].loaded) {
      f.stale = false;
      return;
    }
    if (reload(card)) f.stale = false;
    else setTimeout(function() { show(f); }, 1000);
  }

  // Deleted, or you're no longer in it.
  function lost(f) {
    if (f.gone) return;
    f.gone = true;
    if (f.channel && db) db.removeChannel(f.channel);
    f.channel = null;
    var shown = visibleId(f.id);
    lists = $.grep(lists, function(list) { return list.id !== f.list.id && list.id !== shown; });
    showLists();
    showMessage('“' + f.list.title + '” was deleted, or is no longer shared with you.', null, null, 8000);
  }

  // Back to the page after a while, or back online: save what's waiting, and catch up.
  function check() {
    if (!signedIn() || document.hidden || !db) return;
    $.each(known, function(id, f) {
      if (f.gone || !f.tasks) return;
      if (f.queue.length) return pump(f);
      if (!f.live) refresh(f);
    });
    // Changes made in Google's own apps reach the server within a minute; this is now
    $.each(linked, function(tasklist) {
      var card = cardFor(tasklist);
      if (card.length) poke(tasklist, function(answer) { if (answer && card[0].loaded) reloadSoon(card); });
    });
  }

  // ---- Answering as Google Tasks would

  // As Google Tasks has a task, and changedBy: who last changed it (Tab & Tick's own)
  function taskOf(row) {
    var task = { kind: 'tasks#task', id: row.id, title: row.title || '', status: row.status, position: row.position, updated: row.updated, changedBy: row.updated_by || undefined };
    $.each(['parent', 'notes', 'due', 'completed'], function(i, key) { if (row[key]) task[key] = row[key]; });
    return task;
  }

  function rowOf(task) {
    return { parent: task.parent || null, title: task.title || '', notes: task.notes || null, due: task.due || null,
      status: task.status, completed: task.completed || null, position: task.position };
  }

  function canon(tasks) {
    return JSON.stringify($.map(Object.keys(tasks).sort(), function(id) {
      var t = $.extend({}, tasks[id]);
      delete t.updated;
      return [[id, JSON.stringify(t, Object.keys(t).sort())]];
    }));
  }

  function newId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function siblings(tasks, parent, not) {
    return $.grep($.map(tasks, function(task) { return task; }), function(task) {
      return (task.parent || '') === (parent || '') && task.id !== not;
    }).sort(function(a, b) {
      return a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1;
    });
  }

  // A position after previous among the parent's tasks, or first.
  function place(tasks, parent, previous, not) {
    var list = siblings(tasks, parent, not), at = -1;
    $.each(list, function(i, task) { if (task.id === previous) at = i; });
    var a = at >= 0 ? list[at].position : '', next = list[at + 1];
    return between(a, next ? next.position : null);
  }

  // A string of digits that sorts after a and before b (or anywhere after a when b is
  // null), read as the digits of a fraction. It never ends in 0, so no two differ only
  // by trailing zeros.
  function between(a, b) {
    a = a || '';
    if (b !== null && b !== undefined && b <= a) b = null; // two people put tasks in the same place
    var out = '';
    for (var i = 0; ; i++) {
      var x = i < a.length ? +a.charAt(i) : 0;
      var y = b === null || b === undefined ? 10 : i < b.length ? +b.charAt(i) : 0;
      if (y - x > 1) return out + Math.floor((x + y) / 2);
      out += x;
      if (y - x === 1) b = null; // anything after a's digits from here on is before b
    }
  }

  function request(method, path, body, done, failed) {
    var m = path.match(/^(users\/@me\/)?lists\/cloud%3A([^/?]+)(?:\/tasks(?:\/([^/?]+))?(\/move)?)?(?:\?(.*))?$/);
    if (!m) return later(failed, 400);
    var id = decodeURIComponent(m[2]), whole = !!m[1], taskId = m[3] && decodeURIComponent(m[3]);
    var q = new URLSearchParams(m[5] || '');
    if (whole && method === 'PATCH') return rename(id, (body && body.title) || '', done, failed);
    if (whole) return later(failed, 400);
    load(id, function(f) {
      var tasks = f.tasks, task = taskId && tasks[taskId], result = null;
      if (taskId && !task) return later(failed, 404);
      if (method === 'GET' && !taskId) {
        var min = q.get('updatedMin') || '';
        result = { kind: 'tasks#tasks', items: $.map(tasks, function(t) {
          if (q.get('showCompleted') === 'false' && t.status === 'completed') return null;
          if (min && (t.updated || '') < min) return null;
          return $.extend({}, t);
        }) };
      } else if (method === 'GET') {
        result = $.extend({}, task);
      } else if (method === 'POST' && !taskId) {
        var parent = q.get('parent') || undefined;
        if (parent && (!tasks[parent] || tasks[parent].parent)) return later(failed, 400);
        task = { kind: 'tasks#task', id: newId(), title: '', status: 'needsAction' };
        if (parent) task.parent = parent;
        task.position = place(tasks, parent, q.get('previous'));
        change(task, body || {});
        tasks[task.id] = task;
        save(f, { task: task.id, insert: $.extend({ list_id: f.id, id: task.id }, rowOf(task)) });
        result = $.extend({}, task);
      } else if (method === 'PATCH') {
        change(task, body || {});
        save(f, { task: task.id, update: rowOf(task) });
        result = $.extend({}, task);
      } else if (method === 'DELETE') {
        var gone = $.grep(Object.keys(tasks), function(other) { return other === taskId || tasks[other].parent === taskId; });
        $.each(gone, function(i, other) { delete tasks[other]; });
        $.each(gone, function(i, other) { save(f, { task: other, update: { deleted_at: new Date().toISOString() } }); });
      } else if (method === 'POST' && m[4]) {
        var to = q.get('parent') || undefined;
        if (q.get('destinationTasklist')) return later(failed, 400); // see move()
        if (to && (to === taskId || !tasks[to] || tasks[to].parent)) return later(failed, 400);
        task.position = place(tasks, to, q.get('previous'), taskId);
        if (to) task.parent = to;
        else delete task.parent;
        task.updated = new Date().toISOString();
        task.changedBy = me;
        save(f, { task: task.id, update: { parent: task.parent || null, position: task.position } });
        result = $.extend({}, task);
      } else {
        return later(failed, 400);
      }
      later(done, result);
    }, failed);
  }

  function change(task, body) {
    $.each(['title', 'notes', 'due', 'status', 'completed'], function(i, key) {
      if (!(key in body)) return;
      if (body[key] === null || body[key] === '') delete task[key];
      else task[key] = body[key];
    });
    if (!task.title) task.title = '';
    if (task.status !== 'completed') {
      task.status = 'needsAction';
      delete task.completed;
    } else if (!task.completed) task.completed = new Date().toISOString();
    task.updated = new Date().toISOString();
    task.changedBy = me;
  }

  // Moving a task between a shared list and another list: made in the one, then
  // deleted from the other, as neither the server nor Google can move it across.
  function move(from, taskId, to, previous, done, failed) {
    var base = 'lists/' + encodeURIComponent(from) + '/tasks/' + encodeURIComponent(taskId);
    send('GET', base, null, function(task) {
      var body = { title: task.title || '', notes: task.notes || null, due: task.due || null, status: task.status };
      if (task.status === 'completed' && task.completed) body.completed = task.completed;
      send('POST', 'lists/' + encodeURIComponent(to) + '/tasks' + (previous ? '?previous=' + encodeURIComponent(previous) : ''), body, function(made) {
        send('DELETE', base, null, function() { done(made); }, function(status) {
          if (status === 404) return done(made);
          send('DELETE', 'lists/' + encodeURIComponent(to) + '/tasks/' + encodeURIComponent(made.id), null); // not both
          failed(status);
        });
      }, failed);
    }, failed);
  }

  // ---- Saving: one change at a time, in the order made

  function save(f, op) {
    f.queue.push(op);
    pump(f);
  }

  function pump(f) {
    if (f.saving || !f.queue.length || !db) return;
    var op = f.queue[0];
    f.saving = true;
    var table = db.from('tasks');
    var query = op.insert ? table.insert(op.insert) : table.update(op.update).eq('list_id', f.id).eq('id', op.task);
    answer(query, function() {
      f.saving = false;
      f.queue.shift();
      said = '';
      if (f.queue.length) return pump(f);
      if (f.behind) {
        f.behind = false;
        refresh(f);
      }
    }, function(status, code) {
      f.saving = false;
      if (status === undefined || status >= 500 || status === 401) {
        // Not reached: kept, and tried again when back online or back to the page
        var text = 'Could not save “' + f.list.title + '”.';
        if (said !== text) {
          said = text;
          lastReason = '';
          showFailure(text + ' It’ll be saved when the connection’s back.', status === 401 ? undefined : status);
        }
        return;
      }
      if (op.insert && code === '23505') { // saved already, before a lost answer
        f.queue.shift();
        return pump(f);
      }
      // Refused: perhaps the list was deleted, or you were removed. Show it as it is.
      f.queue = [];
      lastReason = '';
      showFailure('Could not save that change to “' + f.list.title + '”.', status);
      fetchTasks(f, function() { f.stale = true; show(f); }, function() { start(); });
    });
  }

  function unsaved() {
    return $.map(known, function(f) { return f.queue.length ? f : null; }).length > 0;
  }

  // ---- Renaming and removing lists

  function rename(id, title, done, failed) {
    if (!client()) return later(failed, 401);
    answer(db.from('lists').update({ title: title }).eq('id', id).select('id,title,owner').single(), function(row) {
      var f = know(row);
      f.list.renamed = false;
      done(f.list);
    }, failed);
  }

  // Yours is deleted, for everyone; one shared with you is left.
  function remove(listId) {
    var hub = hubOf(listId);
    if (!hub) return;
    var f = entry(hub), list = f.list, mine = isCloud(listId) ? null : listId;
    ask(list.owned ? {
      title: 'Delete “' + list.title + '”?',
      text: 'It’s deleted for everyone it’s shared with, from Tab & Tick and their Google Tasks, and can’t be got back.',
      button: 'Delete', danger: true
    } : {
      title: 'Leave “' + list.title + '”?',
      text: 'It’s removed from your lists and your Google Tasks. Whoever shared it can share it with you again.',
      button: 'Leave', danger: true
    }, function() {
      function gone() {
        f.gone = true;
        if (f.channel && db) db.removeChannel(f.channel);
        f.channel = null;
        lists = $.grep(lists, function(other) { return other.id !== listId; });
        delete copies[hub];
        relink();
        showLists();
        showMessage(list.owned ? 'List deleted.' : 'You’ve left “' + list.title + '”.', null, null, 4000);
        // Your Google list for it, now (the server would, within a minute)
        if (mine) send('DELETE', 'users/@me/lists/' + encodeURIComponent(mine), null, function() {}, function() {});
      }
      function failed(status) {
        lastReason = '';
        showFailure('Could not ' + (list.owned ? 'delete' : 'leave') + ' that list.', status);
      }
      if (!client()) return failed(401);
      whoAmI(function(userId) {
        answer(list.owned ? db.from('lists').delete().eq('id', f.id) :
          db.from('list_members').delete().eq('list_id', f.id).eq('user_id', userId), gone, failed);
      });
    });
  }

  // ---- Sharing

  function link(listId) {
    var page = location.protocol === 'chrome-extension:' ? 'https://tabandtick.github.io/app/' : location.origin + location.pathname;
    return page + '#list=' + encodeURIComponent(hubOf(listId) || '');
  }

  // Who's in the list: done([{ id, user, name, email, role, type, photo, pending }]).
  // Kept, to say who changed what: see who().
  function people(listId, done, failed) {
    var hub = hubOf(listId);
    if (!client() || !hub) return later(failed, 401);
    var f = entry(hub);
    answer(db.rpc('list_people', { l: f.id }), function(rows) {
      var all = $.map(rows || [], function(p) {
        return { id: p.email, user: p.user_id || '', name: p.name || '', email: p.email, role: p.role === 'owner' ? 'owner' : 'writer', type: 'user', photo: p.photo || '', pending: !p.joined };
      });
      f.people = {};
      $.each(all, function(i, p) { if (p.user) f.people[p.user] = p; });
      done(all);
    }, failed);
  }

  // The person with that user id in a list, if known.
  function who(listId, user) {
    var f = known[hubOf(listId)];
    return (f && f.people && f.people[user]) || null;
  }

  // Adds their email. They see the list when they next open Tab & Tick with it.
  function invite(listId, email, done, failed) {
    if (!client()) return later(failed, 401);
    answer(db.from('list_members').insert({ list_id: hubOf(listId), email: email.toLowerCase() }), done, function(status, code) {
      if (code === '23505') return done(); // invited already
      failed(status);
    });
  }

  function uninvite(listId, email, done, failed) {
    if (!client()) return later(failed, 401);
    answer(db.from('list_members').delete().eq('list_id', hubOf(listId)).eq('email', email), done, failed);
  }

  return self;
})();
