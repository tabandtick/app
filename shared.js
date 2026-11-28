// Shared lists. Google Tasks can't share a list with another account, so a shared
// list is kept elsewhere: new ones on Tab & Tick's server (cloudlists.js), and older
// ones, or ones made where the server can't be used, in Google Drive. `shared`, at the
// end, hands each request to the right one.
//
// Drive lists: kept in a file in Google Drive, and Drive shares it as it would any
// file. To the rest of the app it is one more list: send() hands its requests here,
// and they are answered as Google Tasks would answer them, from a copy of the file
// kept in the page. The file is saved soon after each change, and checked every few
// seconds for other people's changes, which are merged in task by task: the later
// change to a task wins, and a deleted task stays deleted.
//
// A list's id is 'drive:' and its file's id; its name is the file's name. The file:
//   { app: 'Tab & Tick', format: 1, tasks: { id: task }, deleted: { id: when } }
// where each task is as Google Tasks has it, with `updated` saying when it changed.

var driveLists = (function() {
  var PREFIX = 'drive:';
  var TYPE = 'application/vnd.tabandtick.list+json';
  var SUFFIX = ' (Tab & Tick)';
  var FIELDS = 'id,name,version,ownedByMe,capabilities(canShare)';
  var APP_ID = '719894949389'; // the Google Cloud project, which Drive gives the access to
  var PICKER_KEY = 'AIzaSyCqli5EautntvKeYkysbazPjc0oxgb2tbg'; // a browser key for Google's file picker
  var files = {}; // by file id: see entry()
  var me = ''; // your Drive permission id, to leave a list
  var problem = ''; // the last save problem shown, so it isn't shown again and again

  var self = {
    base: 'https://www.googleapis.com/', // tests change this
    poll: 5000,
    isShared: isShared,
    request: request,
    lists: sharedLists,
    start: start,
    create: create,
    copy: copy,
    remove: remove,
    move: move,
    unsaved: unsaved,
    flush: flush,
    check: checkAll,
    open: open,
    pick: pick,
    link: link,
    people: people,
    invite: invite,
    uninvite: uninvite,
    reset: reset,
    merge: merge,
    between: between
  };

  function reset() {
    $.each(files, function(id, f) { clearTimeout(f.timer); });
    files = {};
    me = '';
    problem = '';
  }

  function isShared(list) {
    return typeof list === 'string' && list.indexOf(PREFIX) === 0;
  }

  function entry(id) {
    return files[id] || (files[id] = {
      id: id,
      list: { id: PREFIX + id, title: '', shared: true },
      doc: null,      // the copy in the page
      version: null,  // Drive's version of the file that doc was last merged with
      waiting: [],    // callers waiting for it to load
      saving: false, again: false, dirty: false, timer: null,
      stale: false    // changed by someone else, and not yet shown
    });
  }

  function sharedLists() {
    return $.map(files, function(f) { return f.gone || !f.list.title ? null : f.list; });
  }

  function titleOf(name) {
    name = name || '';
    return name.slice(-SUFFIX.length) === SUFFIX ? name.slice(0, -SUFFIX.length) : name;
  }

  function later(f, value) {
    if (f) setTimeout(function() { f(value); }, 0);
  }

  // Calls Drive. done(result), or failed(status), which is undefined when Drive
  // couldn't be reached. options: { type, keepalive }.
  function drive(method, path, body, done, failed, options) {
    options = options || {};
    var started = session;
    var init = { method: method, headers: { 'Authorization': 'Bearer ' + auth.token() }, keepalive: !!options.keepalive };
    if (body !== null && body !== undefined) {
      init.headers['Content-Type'] = options.type || 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    fetch(self.base + path, init).then(function(response) {
      return response.text().then(function(text) {
        if (!response.ok) {
          var reason = '';
          try { reason = JSON.parse(text).error.message; } catch (e) { /* not Google's usual answer */ }
          throw { status: response.status, reason: reason };
        }
        return text ? JSON.parse(text) : null;
      });
    }).then(function(result) {
      if (started === session && done) done(result);
    }, function(error) {
      if (started !== session) return;
      lastReason = (error && error.reason) || '';
      console.info('Drive: ' + method + ' ' + path.split('?')[0] + ' ' + ((error && error.status) || '') + ' ' + lastReason);
      if (failed) failed(error && error.status);
    });
  }

  // ---- Which lists there are

  // Ask Drive for the shared lists you have, then call done.
  function start(done) {
    if (!auth.hasDrive()) return later(done);
    drive('GET', 'drive/v3/files?q=' + encodeURIComponent("mimeType='" + TYPE + "' and trashed=false") +
      '&orderBy=createdTime&pageSize=100&fields=' + encodeURIComponent('files(' + FIELDS + ')'), null, function(result) {
      $.each((result && result.files) || [], function(i, meta) { know(meta); });
      if (done) done();
    }, function() {
      if (done) done();
    });
  }

  function know(meta) {
    var f = entry(meta.id);
    f.gone = false;
    f.list.title = titleOf(meta.name);
    f.list.owned = !!meta.ownedByMe;
    f.list.canShare = !(meta.capabilities && meta.capabilities.canShare === false);
    return f;
  }

  // The list's file, loaded once. done(f), or failed(status).
  function load(id, done, failed) {
    var f = entry(id);
    if (f.doc) return done(f);
    f.waiting.push([done, failed]);
    if (f.waiting.length > 1) return;
    function finish(ok, status) {
      $.each(f.waiting.splice(0), function(i, w) {
        if (ok) w[0](f);
        else if (w[1]) w[1](status);
      });
    }
    drive('GET', 'drive/v3/files/' + id + '?fields=' + encodeURIComponent(FIELDS), null, function(meta) {
      know(meta);
      drive('GET', 'drive/v3/files/' + id + '?alt=media', null, function(doc) {
        f.doc = tidy(doc);
        f.version = meta.version;
        finish(true);
      }, function(status) { finish(false, status); });
    }, function(status) { finish(false, status); });
  }

  function tidy(doc) {
    doc = doc && typeof doc === 'object' ? doc : {};
    return { app: 'Tab & Tick', format: 1, tasks: doc.tasks || {}, deleted: doc.deleted || {} };
  }

  // ---- Answering as Google Tasks would

  function now() {
    return new Date().toISOString();
  }

  function newId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function copyOf(task) {
    return $.extend({ kind: 'tasks#task' }, task);
  }

  function siblings(doc, parent, not) {
    return $.grep($.map(doc.tasks, function(task) { return task; }), function(task) {
      return (task.parent || '') === (parent || '') && task.id !== not;
    }).sort(function(a, b) {
      return a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1;
    });
  }

  // A position after previous among the parent's tasks, or first.
  function place(doc, parent, previous, not) {
    var list = siblings(doc, parent, not), at = -1;
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
    var m = path.match(/^(users\/@me\/)?lists\/drive%3A([^/?]+)(?:\/tasks(?:\/([^/?]+))?(\/move)?)?(?:\?(.*))?$/);
    if (!m) return later(failed, 400);
    var id = decodeURIComponent(m[2]), whole = !!m[1], taskId = m[3] && decodeURIComponent(m[3]);
    var q = new URLSearchParams(m[5] || '');
    if (whole && method === 'PATCH') return rename(id, body.title, done, failed);
    load(id, function(f) {
      var doc = f.doc, task = taskId && doc.tasks[taskId], result = {};
      if (taskId && !task) return later(failed, 404);
      if (whole) return later(failed, 400);
      if (method === 'GET' && !taskId) {
        var min = q.get('updatedMin') || '';
        result = { kind: 'tasks#tasks', items: $.map(doc.tasks, function(t) {
          if (q.get('showCompleted') === 'false' && t.status === 'completed') return null;
          if (min && (t.updated || '') < min) return null;
          return copyOf(t);
        }) };
      } else if (method === 'GET') {
        result = copyOf(task);
      } else if (method === 'POST' && !taskId) {
        var parent = q.get('parent') || undefined;
        if (parent && (!doc.tasks[parent] || doc.tasks[parent].parent)) return later(failed, 400);
        task = { id: newId(), title: '', status: 'needsAction' };
        if (parent) task.parent = parent;
        task.position = place(doc, parent, q.get('previous'));
        change(task, body || {});
        doc.tasks[task.id] = task;
        result = copyOf(task);
      } else if (method === 'PATCH') {
        change(task, body || {});
        result = copyOf(task);
      } else if (method === 'DELETE') {
        var when = now();
        $.each(doc.tasks, function(other, t) {
          if (other === taskId || t.parent === taskId) {
            delete doc.tasks[other];
            doc.deleted[other] = when;
          }
        });
        result = null;
      } else if (method === 'POST' && m[4]) {
        var to = q.get('parent') || undefined;
        if (q.get('destinationTasklist')) return later(failed, 400); // see move()
        if (to && (to === taskId || !doc.tasks[to] || doc.tasks[to].parent)) return later(failed, 400);
        task.position = place(doc, to, q.get('previous'), taskId);
        if (to) task.parent = to;
        else delete task.parent;
        task.updated = now();
        result = copyOf(task);
      } else {
        return later(failed, 400);
      }
      if (method !== 'GET') saveSoon(f);
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
    } else if (!task.completed) task.completed = now();
    task.updated = now();
  }

  // Moving a task between a shared list and another list: made in the one, then
  // deleted from the other, as neither Drive nor Google can move it across.
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

  // ---- Saving, and hearing of other people's changes

  function saveSoon(f) {
    f.dirty = true;
    clearTimeout(f.timer);
    f.timer = setTimeout(function() { save(f); }, 300);
  }

  function save(f) {
    clearTimeout(f.timer);
    if (!f.doc) return;
    if (f.saving) {
      f.again = true;
      return;
    }
    f.saving = true;
    f.again = false;
    f.dirty = false;
    function failed(status) {
      f.saving = false;
      f.dirty = true; // the next check tries again
      if (status === 404) return lost(f);
      var text = 'Could not save “' + f.list.title + '”.';
      if (problem !== text) {
        problem = text;
        showFailure(text + ' Trying again.', status);
      }
    }
    // Merge in what others have saved since, so as not to save over it
    fresh(f, function() {
      drive('PATCH', 'upload/drive/v3/files/' + f.id + '?uploadType=media&fields=version', JSON.stringify(f.doc), function(result) {
        f.version = result.version;
        f.saving = false;
        problem = '';
        if (f.again || f.dirty) save(f);
      }, failed, { type: TYPE });
    }, failed);
  }

  // Bring the copy up to date with Drive's, then call done.
  function fresh(f, done, failed) {
    drive('GET', 'drive/v3/files/' + f.id + '?fields=' + encodeURIComponent(FIELDS), null, function(meta) {
      var title = titleOf(meta.name);
      if (title !== f.list.title) {
        f.list.title = title;
        f.list.renamed = true;
        show(f);
      }
      if (meta.version === f.version) return done();
      drive('GET', 'drive/v3/files/' + f.id + '?alt=media', null, function(doc) {
        var theirs = tidy(doc), before = canon(f.doc);
        f.doc = merge(f.doc, theirs);
        f.version = meta.version;
        var after = canon(f.doc);
        if (after !== canon(theirs)) f.dirty = true; // they don't have something here yet
        if (after !== before) {
          f.stale = true;
          show(f);
        }
        done();
      }, failed);
    }, failed);
  }

  function checkAll() {
    if (!signedIn() || !auth.hasDrive() || document.hidden) return;
    $.each(files, function(id, f) {
      if (!f.doc || f.saving || f.gone) return;
      if (f.dirty) return save(f);
      fresh(f, function() {}, function(status) {
        if (status === 404) lost(f);
      });
    });
  }

  setInterval(function() { checkAll(); }, self.poll);

  // Show what others changed, unless that would get in the way: then try again soon.
  function show(f) {
    if (f.list.renamed) {
      f.list.renamed = false;
      showLists();
    }
    if (!f.stale) return;
    var card = cardFor(f.list.id);
    if (!card.length || !card[0].loaded) {
      f.stale = false;
      return;
    }
    if (reload(card)) f.stale = false;
    else setTimeout(function() { show(f); }, 1000);
  }

  // The file was deleted, or is no longer shared with you.
  function lost(f) {
    if (f.gone) return;
    f.gone = true;
    lists = $.grep(lists, function(list) { return list.id !== f.list.id; });
    showLists();
    showMessage('“' + f.list.title + '” was deleted, or is no longer shared with you.', null, null, 8000);
  }

  function canon(doc) {
    function sorted(o) {
      return $.map(Object.keys(o).sort(), function(k) {
        var v = o[k];
        return [[k, typeof v === 'object' ? JSON.stringify(v, Object.keys(v).sort()) : v]];
      });
    }
    return JSON.stringify([sorted(doc.tasks), sorted(doc.deleted)]);
  }

  // Theirs and ours together: the later change to each task, and every deletion
  // since. A tie goes the same way on both sides.
  function merge(ours, theirs) {
    var out = tidy({}), cutoff = new Date(Date.now() - 60 * 864e5).toISOString();
    $.each([ours.deleted, theirs.deleted], function(i, deleted) {
      $.each(deleted, function(id, when) {
        if (when > cutoff && when > (out.deleted[id] || '')) out.deleted[id] = when;
      });
    });
    $.each([ours.tasks, theirs.tasks], function(i, tasks) {
      $.each(tasks, function(id, task) {
        var other = out.tasks[id];
        if (other) {
          var a = other.updated || '', b = task.updated || '';
          if (b < a || (b === a && JSON.stringify(task) <= JSON.stringify(other))) return;
        }
        out.tasks[id] = task;
      });
    });
    $.each(out.tasks, function(id, task) {
      if (out.deleted[id] && out.deleted[id] >= (task.updated || '')) delete out.tasks[id];
    });
    return out;
  }

  function unsaved() {
    return $.map(files, function(f) { return f.dirty || f.saving ? f : null; }).length > 0;
  }

  // As the page closes: save what hasn't been, without waiting to merge.
  function flush() {
    $.each(files, function(id, f) {
      if (!f.doc || !(f.dirty || f.again)) return;
      clearTimeout(f.timer);
      drive('PATCH', 'upload/drive/v3/files/' + id + '?uploadType=media', JSON.stringify(f.doc), null, null, { type: TYPE, keepalive: true });
    });
  }

  // ---- Making, renaming and removing lists

  function fileName(title) {
    return title + SUFFIX;
  }

  // A new shared list in your Drive, with the given tasks (as Google Tasks has them).
  // done(list), or failed(status).
  function create(title, tasks, done, failed) {
    var doc = tidy({}), ids = {}, when = now();
    $.each(tasks || [], function(i, task) { ids[task.id] = newId(); });
    $.each(tasks || [], function(i, task) {
      var copy = { id: ids[task.id], title: task.title || '', status: task.status === 'completed' ? 'completed' : 'needsAction', position: task.position || '5', updated: when };
      if (task.parent && ids[task.parent]) copy.parent = ids[task.parent];
      $.each(['notes', 'due', 'completed'], function(j, key) { if (task[key]) copy[key] = task[key]; });
      doc.tasks[copy.id] = copy;
    });
    var meta = { name: fileName(title), mimeType: TYPE, appProperties: { tabandtick: 'list' } };
    var b = 'tabandtick' + Math.random().toString(36).slice(2);
    var body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
      '\r\n--' + b + '\r\nContent-Type: ' + TYPE + '\r\n\r\n' + JSON.stringify(doc) + '\r\n--' + b + '--';
    drive('POST', 'upload/drive/v3/files?uploadType=multipart&fields=' + encodeURIComponent(FIELDS), body, function(file) {
      var f = know(file);
      f.doc = doc;
      f.version = file.version;
      done(f.list);
    }, failed, { type: 'multipart/related; boundary=' + b });
  }

  // A shared copy of a Google Tasks list, with its open tasks.
  function copy(list, done, failed) {
    fetchAll(list.id, 'showCompleted=false', function(tasks) {
      create(list.title, tasks, done, failed);
    }, failed);
  }

  function rename(id, title, done, failed) {
    drive('PATCH', 'drive/v3/files/' + id + '?fields=' + encodeURIComponent(FIELDS), { name: fileName(title) }, function(meta) {
      know(meta);
      if (files[id].doc) files[id].version = null; // the version changed; look again next time
      done(files[id].list);
    }, failed);
  }

  // Yours goes to the bin in your Drive, for everyone; one shared with you is left.
  function remove(listId) {
    var f = entry(listId.slice(PREFIX.length)), list = f.list;
    ask(list.owned ? {
      title: 'Delete “' + list.title + '”?',
      text: 'It’s deleted for everyone it’s shared with. You can get it back from the bin in Google Drive for 30 days.',
      button: 'Delete', danger: true
    } : {
      title: 'Leave “' + list.title + '”?',
      text: 'It’s removed from your lists. Whoever shared it can share it with you again.',
      button: 'Leave', danger: true
    }, function() {
      function gone() {
        f.gone = true;
        lists = $.grep(lists, function(other) { return other.id !== listId; });
        showLists();
        showMessage(list.owned ? 'List deleted.' : 'You’ve left “' + list.title + '”.', null, null, 4000);
      }
      function failed(status) { showFailure('Could not ' + (list.owned ? 'delete' : 'leave') + ' that list.', status); }
      if (list.owned) return drive('PATCH', 'drive/v3/files/' + f.id + '?fields=id', { trashed: true }, gone, failed);
      whoAmI(function(permissionId) {
        drive('DELETE', 'drive/v3/files/' + f.id + '/permissions/' + permissionId, null, gone, failed);
      }, failed);
    });
  }

  function whoAmI(done, failed) {
    if (me) return done(me);
    drive('GET', 'drive/v3/about?fields=user(permissionId)', null, function(about) {
      me = about.user.permissionId;
      done(me);
    }, failed);
  }

  // ---- Sharing

  function link(listId) {
    var page = location.protocol === 'chrome-extension:' ? 'https://tabandtick.github.io/app/' : location.origin + location.pathname;
    return page + '#open=' + encodeURIComponent(listId.slice(PREFIX.length));
  }

  // Who has the list: done([{ id, name, email, role }]).
  function people(listId, done, failed) {
    drive('GET', 'drive/v3/files/' + listId.slice(PREFIX.length) + '/permissions?fields=' +
      encodeURIComponent('permissions(id,type,role,emailAddress,displayName,photoLink)'), null, function(result) {
      done($.map((result && result.permissions) || [], function(p) {
        return { id: p.id, name: p.displayName || '', email: p.emailAddress || '', role: p.role, type: p.type, photo: p.photoLink || '' };
      }));
    }, failed);
  }

  // Drive emails them, with a note that has the link to open it here.
  function invite(listId, email, done, failed) {
    var note = 'Open it in Tab & Tick: ' + link(listId);
    drive('POST', 'drive/v3/files/' + listId.slice(PREFIX.length) + '/permissions?sendNotificationEmail=true&emailMessage=' + encodeURIComponent(note),
      { type: 'user', role: 'writer', emailAddress: email }, done, failed);
  }

  function uninvite(listId, permissionId, done, failed) {
    drive('DELETE', 'drive/v3/files/' + listId.slice(PREFIX.length) + '/permissions/' + permissionId, null, done, failed);
  }

  // ---- Opening a list someone shared with you

  // done(list) once it's yours to open, or failed(status). Drive only lets an app
  // open a file shared with you once you've picked it, so a 404 means pick().
  function open(id, done, failed) {
    var f = entry(id);
    if (f.doc && !f.gone) return done(f.list);
    drive('GET', 'drive/v3/files/' + id + '?fields=' + encodeURIComponent(FIELDS), null, function(meta) {
      know(meta);
      done(f.list);
    }, failed);
  }

  // In the extension, Google's file picker can't be loaded, so the website opens it.
  // The access it gives is to Tab & Tick, so the extension can then open the list too.
  function pickOnWebsite(id) {
    window.open('https://tabandtick.github.io/app/#' + (id ? 'open=' + encodeURIComponent(id) : 'pick'), '_blank');
    showMessage('Open it on the website, then come back: it’ll be here too.', null, null, 10000);
  }

  var pickerReady = null; // waiting callers, then true

  // Google's file picker, showing just this file if given: done(file id) once picked.
  function pick(id, done) {
    if (location.protocol === 'chrome-extension:') return pickOnWebsite(id);
    if (!PICKER_KEY) return showMessage('Opening shared lists isn’t set up here yet.', null, null, 6000);
    if (pickerReady === true) return picker(id, done);
    if (pickerReady) return pickerReady.push(function() { picker(id, done); });
    pickerReady = [function() { picker(id, done); }];
    var script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = function() {
      gapi.load('picker', function() {
        var waiting = pickerReady;
        pickerReady = true;
        $.each(waiting, function(i, f) { f(); });
      });
    };
    script.onerror = function() {
      pickerReady = null;
      showMessage('Google’s file picker couldn’t load. Check your connection.', null, null, 6000);
    };
    document.head.appendChild(script);
  }

  function picker(id, done) {
    var view = new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes(TYPE).setMode(google.picker.DocsViewMode.LIST);
    if (id) view.setFileIds(id);
    new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(auth.token())
      .setDeveloperKey(PICKER_KEY)
      .setAppId(APP_ID)
      .setTitle('Open a shared list')
      .setCallback(function(data) {
        if (data.action !== google.picker.Action.PICKED) return;
        done(data.docs[0].id);
      })
      .build()
      .setVisible(true);
  }

  return self;
})();

// The app's way to shared lists, wherever each is kept.
var shared = (function() {
  function by(listId) {
    return cloudLists.isCloud(listId) ? cloudLists : driveLists;
  }
  function both(name) {
    return function() {
      driveLists[name].apply(null, arguments);
      return cloudLists[name].apply(null, arguments);
    };
  }
  // New lists go to Tab & Tick's server when it can be used, as it's quicker and
  // needs no Drive; if not, to Drive.
  function maker() {
    return cloudLists.available() ? cloudLists : driveLists;
  }
  var self = {
    isShared: function(list) { return driveLists.isShared(list) || cloudLists.isCloud(list); },
    inCloud: function() { return cloudLists.available(); },
    request: function(method, path, body, done, failed) {
      return (/^(users\/@me\/)?lists\/cloud%3A/.test(path) ? cloudLists : driveLists).request(method, path, body, done, failed);
    },
    lists: function() { return driveLists.lists().concat(cloudLists.lists()); },
    start: function(done) {
      var waiting = 2;
      function one() { if (--waiting === 0 && done) done(); }
      driveLists.start(one);
      cloudLists.start(one);
    },
    create: function(title, tasks, done, failed) { maker().create(title, tasks, done, failed); },
    copy: function(list, done, failed) { maker().copy(list, done, failed); },
    remove: function(listId) { by(listId).remove(listId); },
    move: driveLists.move, // works for both, through send()
    unsaved: function() { return driveLists.unsaved() || cloudLists.unsaved(); },
    flush: both('flush'),
    check: both('check'),
    reset: both('reset'),
    link: function(listId) { return by(listId).link(listId); },
    people: function(listId, done, failed) { by(listId).people(listId, done, failed); },
    invite: function(listId, email, done, failed) { by(listId).invite(listId, email, done, failed); },
    uninvite: function(listId, who, done, failed) { by(listId).uninvite(listId, who, done, failed); },
    hasCloud: function(id) { return cloudLists.has(id); },
    open: driveLists.open,
    pick: driveLists.pick,
    merge: driveLists.merge,
    between: driveLists.between
  };
  Object.defineProperty(self, 'base', { get: function() { return driveLists.base; }, set: function(v) { driveLists.base = v; } });
  return self;
})();
