var CLIENT_ID = '146982777170-h1btpb05ltctf58n4f9foqof665i08j7.apps.googleusercontent.com';
var SCOPES = ['https://www.googleapis.com/auth/tasks'];
// The signed-in user's own default list.
var TASK_LIST = '@default';
var tasksLoaded = false;

function checkAuth() {
  gapi.auth.authorize(
    {
      'client_id': CLIENT_ID,
      'scope': SCOPES.join(' '),
      'immediate': true
    }, handleAuthResult);
}

function handleAuthResult(authResult) {
  if (authResult && !authResult.error) {
    showStatus('Loading\u2026');
    listTasks();
  } else {
    showLogIn();
  }
}

// Shows a message in place of the Log In button; '' shows neither.
function showStatus(message) {
  $('#status').text(message);
  $('#authorize-div').hide();
}

function showLogIn() {
  if (tasksLoaded) return;
  $('#status').text('');
  $('#authorize-div').show();
}

// The silent sign-in sometimes never answers, so don't wait for it forever.
setTimeout(function() {
  if (!signedIn()) showLogIn();
}, 6000);

function signedIn() {
  return !!(window.gapi && gapi.auth && gapi.auth.getToken && gapi.auth.getToken());
}

function handleAuthClick(event) {
  gapi.auth.authorize(
    {client_id: CLIENT_ID, scope: SCOPES, immediate: false},
    handleAuthResult);
  return false;
}

// Calls the Tasks API on the list. done(result) on success, failed(status) if not.
function api(method, path, body, done, failed) {
  var request = {
    path: 'https://www.googleapis.com/tasks/v1/lists/' + TASK_LIST + '/tasks' + path,
    method: method
  };
  if (body) request.body = body;
  gapi.client.request(request).then(function(resp) {
    if (done) done(resp.result);
  }, function(err) {
    console.error(method + ' failed', err);
    if (failed) failed(err && err.status);
  });
}

var messageTimer;
var undoShown = false; // whether the message is for undoing a removal

function showMessage(text, button, onClick, ms) {
  clearTimeout(messageTimer);
  undoShown = false;
  $('#message span').text(text);
  $('#message button').toggle(!!button).text(button || '').off('click').on('click', function() {
    hideMessage();
    onClick();
  });
  $('#message').show();
  if (ms) messageTimer = setTimeout(hideMessage, ms);
}

function hideMessage() {
  clearTimeout(messageTimer);
  undoShown = false;
  $('#message').hide();
}

// Google's access runs out after about an hour, which shows up as a 401.
function showFailure(text, status, retry) {
  if (status === 401) showMessage(text + ' Please log in again.', 'Log in', handleAuthClick);
  else showMessage(text, retry && 'Retry', retry, retry ? 0 : 6000);
}

function listTasks() {
  if (tasksLoaded) return saveAll(); // logged in again: save what couldn't be saved
  fetchAll('showCompleted=false', function(tasks) {
    if (tasksLoaded) return; // a late silent sign-in must not list them twice
    tasksLoaded = true;
    showStatus('');
    showTasks(tasks);
  }, showLogIn);
}

// Google returns at most 100 tasks at a time.
function fetchAll(query, done, failed, tasks, pageToken) {
  api('GET', '?maxResults=100&' + query + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), null, function(result) {
    var all = (tasks || []).concat((result && result.items) || []);
    if (result && result.nextPageToken) return fetchAll(query, done, failed, all, result.nextPageToken);
    done(all);
  }, failed);
}

// Google doesn't send tasks in order. Position sorts tasks that share a parent,
// so put each task's subtasks straight after it.
function inOrder(tasks) {
  var ids = {}, children = {}, sorted = [];
  $.each(tasks, function(i, task) { ids[task.id] = true; });
  $.each(tasks, function(i, task) {
    var parent = ids[task.parent] ? task.parent : '';
    (children[parent] = children[parent] || []).push(task);
  });
  (function add(parent) {
    var list = (children[parent] || []).sort(function(a, b) {
      return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
    });
    $.each(list, function(i, task) {
      sorted.push(task);
      add(task.id);
    });
  })('');
  return sorted;
}

function showTasks(tasks) {
  $('#claire').empty().append($.map(inOrder(tasks), taskRow));
  $('#claire .todo').each(function() { // not indented if its parent isn't here
    if (this.parentTask && !document.getElementById(this.parentTask)) $(this).parent().removeClass('subtask');
  });
  $('#done').show();
  refreshRows();
}

function refreshRows() {
  autosizeAll();
  updateToDoCount();
  toggleToDoCheckboxes();
  updateDoneCount();
}

// Measure every row before changing any: mixing the two is slow with many rows.
function autosizeAll() {
  var shown = $('.todo').filter(function() { return this.offsetParent; });
  shown.css('height', 'auto');
  var heights = shown.map(function() { return this.scrollHeight; }).get();
  shown.each(function(i) { this.style.height = heights[i] + 'px'; });
}

// Show the list as Google now has it, unless that would lose something.
function reload() {
  if (!signedIn() || busy()) return;
  fetchAll('showCompleted=false', function(tasks) {
    if (busy()) return;
    var active = $(document.activeElement);
    var id = active.closest('#claire li').children('.todo').attr('id');
    var field = active.is('.notes') ? '.notes' : '.todo';
    var start = active[0] && active[0].selectionStart;
    var open = $('#claire li.open .todo').map(function() { return this.id; }).get();
    showTasks(tasks);
    $('#claire .todo').each(function() {
      var row = $(this).parent();
      if ($.inArray(this.id, open) >= 0) row.addClass('open').children('.more').attr('aria-expanded', 'true');
      if (id && this.id === id) row.find(field).setCursorPosition(start || 0);
    });
  });
}

function busy() {
  return removals.length > 0 || $('#claire .todo').filter(function() {
    return !this.id || this.saving || isUnsaved($(this));
  }).length > 0;
}

// ---- Completed tasks, loaded only when asked for, newest first

var doneDays = [30, 365, 0]; // how far back each "Show older" goes; 0 is everything
var doneShown = 0;

function toggleDone() {
  var open = !$('#done').hasClass('open');
  $('#done').toggleClass('open', open);
  $('#done-toggle').attr('aria-expanded', String(open));
  if (open && !doneShown) loadDone();
  refreshRows();
}

function loadDone() {
  var days = doneDays[doneShown];
  var since = days ? new Date(Date.now() - days * 864e5) : new Date(0);
  $('#done-more').prop('disabled', true).text('Loading…').show();
  fetchAll('showCompleted=true&showHidden=true&completedMin=' + encodeURIComponent(since.toISOString()), function(tasks) {
    doneShown++;
    var more = doneShown < doneDays.length;
    $('#done-more').prop('disabled', false).text('Show older').toggle(more);
    $.each(tasks, function(i, task) {
      if (task.status === 'completed' && !document.getElementById(task.id)) $('#done-list').append(taskRow(task));
    });
    sortDone();
    var none = !$('#done-list li').length;
    $('#done-none').text(more ? 'None in the last ' + (days === 30 ? '30 days' : 'year') : 'None').toggle(none);
  }, function(status) {
    $('#done-more').prop('disabled', false).text(doneShown ? 'Show older' : 'Try again');
    showFailure('Could not load completed tasks.', status);
  });
}

function updateDoneCount() {
  var since = ['', ' in the last 30 days', ' in the last year', ''][doneShown];
  $('#done-toggle').text('Completed' + (doneShown ? ' (' + $('#done-list li').length + since + ')' : ''));
}

function sortDone() {
  var rows = $('#done-list li').get().sort(function(a, b) {
    var x = $(a).children('.todo')[0].completedAt || '', y = $(b).children('.todo')[0].completedAt || '';
    return x < y ? 1 : x > y ? -1 : 0;
  });
  $('#done-list').append(rows);
  if (rows.length) $('#done-none').hide();
  refreshRows();
}

// Tick or untick. The row moves between the lists once Google agrees.
function setCompleted(checkbox) {
  var todo = checkbox.siblings('.todo');
  var row = todo.parent();
  var done = checkbox.prop('checked');
  var id = todo.attr('id');
  todo.toggleClass('checked', done);
  if (!id) return; // saveTask sends it once the task exists
  var hadSubtasks = subtaskRows(todo).length > 0;
  api('PATCH', '/' + id, done ? { status: 'completed' } : { status: 'needsAction', completed: null }, function(result) {
    if (checkbox.prop('checked') !== done) return; // changed again since
    todo[0].completedAt = done ? (result && result.completed) || new Date().toISOString() : undefined;
    if (todo[0].deleted) return;
    row.removeClass('selected');
    if (done) {
      $('#done-list').prepend(row);
      sortDone();
      if (hadSubtasks) reload(); // Google decides what happens to its subtasks
    } else {
      $('#claire').prepend(row);
      refreshRows();
      reload(); // puts it back in its place
    }
    renderMeta(row);
    if (done && !removals.length) { // keep the undo for a delete, if there is one
      showMessage('Task completed.', 'Undo', function() {
        checkbox.prop('checked', false);
        setCompleted(checkbox);
      }, 7000);
    }
  }, function(status) {
    checkbox.prop('checked', !done);
    todo.toggleClass('checked', !done);
    showFailure('Could not update that task.', status);
  });
}

// ---- Rows

function text(value) {
  return (value || '').replace(/\r\n?/g, '\n');
}

// Values are set with .val() and .text(), so quotes and HTML stay as text.
function taskRow(task) {
  var done = task.status === 'completed';
  var todo = $('<textarea class="todo" rows="1" aria-label="Task"></textarea>').toggleClass('checked', done)
    .val(text(task.title).replace(/\n/g, ' '));
  var notes = $('<textarea class="notes" rows="3" placeholder="Notes" aria-label="Notes"></textarea>').val(text(task.notes));
  var due = $('<input type="date" class="due" aria-label="Due date" min="2000-01-01" max="2999-12-31"/>').val((task.due || '').slice(0, 10));
  var row = $('<li></li>').toggleClass('subtask', !!task.parent).append(
    $('<input type="checkbox" aria-label="Completed"/>').prop('checked', done),
    todo,
    $('<button type="button" class="more" aria-label="Notes and due date" title="Notes and due date" aria-expanded="false">&#8943;</button>'),
    $('<div class="meta"><span class="when"></span><span class="preview"></span></div>'),
    $('<div class="details"></div>').append(notes, $('<label>Due </label>').append(due), $('<button type="button" class="clear-due">Clear date</button>'))
  );
  if (task.id) todo.attr('id', task.id);
  todo[0].parentTask = task.parent;
  todo[0].completedAt = task.completed;
  todo[0].saved = { title: todo.val(), notes: notes.val(), due: due.val() };
  renderMeta(row);
  return row;
}

function autosize(todo) {
  var el = todo[0];
  if (!el || !el.offsetParent) return; // hidden
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function isoDay(date) {
  function two(n) { return (n < 10 ? '0' : '') + n; }
  return date.getFullYear() + '-' + two(date.getMonth() + 1) + '-' + two(date.getDate());
}

function dayName(due) {
  var now = new Date();
  for (var i = -1; i <= 1; i++) {
    if (due === isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i))) return ['Yesterday', 'Today', 'Tomorrow'][i + 1];
  }
  var d = due.split('-');
  var options = { weekday: 'short', day: 'numeric', month: 'short' };
  if (+d[0] !== now.getFullYear()) options.year = 'numeric';
  return new Date(d[0], d[1] - 1, d[2]).toLocaleDateString(undefined, options);
}

function renderMeta(row) {
  var values = current(row.children('.todo'));
  var overdue = values.due && values.due < isoDay(new Date()) && !row.children('input[type=checkbox]').prop('checked');
  var completedAt = row.children('.todo')[0].completedAt;
  var when = completedAt ? 'Completed: ' + dayName(isoDay(new Date(completedAt)))
    : values.due ? (overdue ? 'Overdue: ' : '') + dayName(values.due) : '';
  row.find('.when').text(when).toggleClass('overdue', !!overdue);
  row.find('.preview').text(values.notes.split('\n')[0]);
  row.children('.meta').toggle(!!(when || values.notes));
}

function subtaskRows(todo) {
  var id = todo.closest('#claire').length && todo.attr('id');
  return $('#claire .todo').filter(function() { return id && this.parentTask === id; }).parent();
}

// ---- Saving. State lives on the .todo element, not in .data():
//   saved    what Google has          saving   a save is in progress
//   deleted  hidden, can be undone    gone     no longer undoable

function current(todo) {
  var row = todo.parent();
  var due = row.find('.due')[0];
  return {
    title: todo.val(),
    notes: row.find('.notes').val(),
    due: due.validity.valid ? due.value : todo[0].saved.due // ignore half-typed dates
  };
}

function changes(todo) {
  var now = current(todo), saved = todo[0].saved, body = {};
  if (now.title !== saved.title) body.title = now.title;
  if (now.notes !== saved.notes) body.notes = now.notes;
  if (now.due !== saved.due) body.due = now.due ? now.due + 'T00:00:00.000Z' : null;
  return body;
}

function isUnsaved(todo) {
  if (!todo[0] || todo[0].deleted) return false;
  if (!todo.attr('id') && !todo.val()) return false;
  return !$.isEmptyObject(changes(todo));
}

// The nearest row above with the same parent that matches, as an element.
function siblingAbove(todo, matches) {
  var parent = todo[0].parentTask;
  return todo.parent().prevAll().children('.todo').filter(function() {
    return this.parentTask === parent && matches(this);
  }).first()[0];
}

// Where to create a task: after the sibling above it, or first.
function placement(todo) {
  var above = siblingAbove(todo, function(el) { return el.id; });
  var parent = todo[0].parentTask;
  var query = [];
  if (above) query.push('previous=' + encodeURIComponent(above.id));
  if (parent) query.push('parent=' + encodeURIComponent(parent));
  return query.length ? '?' + query.join('&') : '';
}

// A new row waits for a new row above it, so that they are created in order.
function mustWait(todo) {
  var above = siblingAbove(todo, function(el) { return el.id || isUnsaved($(el)); });
  if (!above || above.id || above.failed) return false;
  saveTask($(above));
  return true;
}

// Save what changed in a row, creating the task the first time.
function saveTask(todo) {
  var el = todo[0];
  if (!el) return;
  clearTimeout(el.timer);
  if (el.saving || !isUnsaved(todo)) return;
  var id = todo.attr('id');
  if (!id && mustWait(todo)) return saveSoon(todo);
  var sent = current(todo);
  el.saving = true;
  api(id ? 'PATCH' : 'POST', id ? '/' + id : placement(todo), changes(todo), function(result) {
    el.saving = el.failed = false;
    el.saved = sent;
    if (!id) {
      todo.attr('id', result.id);
      el.parentTask = result.parent;
      if (el.gone) return deleteTask(todo);
      var box = todo.siblings('input[type=checkbox]');
      if (box.prop('checked')) setCompleted(box);
    }
    saveTask(todo); // it may have changed while saving
  }, function(status) {
    el.saving = false;
    el.failed = true;
    if (!el.gone) showFailure('Could not save your changes.', status, saveAll);
  });
}

// Save shortly after typing stops, so closing the tab loses nothing.
function saveSoon(todo) {
  var el = todo[0];
  if (!el) return;
  clearTimeout(el.timer);
  el.timer = setTimeout(function() { saveTask(todo); }, 800);
}

function saveAll() {
  $('.todo').each(function() { saveTask($(this)); });
}

// ---- Deleting and joining, with undo

var removals = []; // rows hidden but not yet deleted from Google, oldest first

// Hide a task and its subtasks now, and delete them in a few seconds, unless undone.
function removeRow(todo, message, onUndo) {
  var subtasks = subtaskRows(todo);
  var rows = todo.parent().add(subtasks);
  var removal = { todos: rows.children('.todo'), next: rows.last().next(), prev: rows.first().prev(), list: todo.parent().parent(), onUndo: onUndo };
  removal.text = message || 'Task ' + (subtasks.length ? 'and ' + subtasks.length + ' subtask' + (subtasks.length > 1 ? 's ' : ' ') : '') + 'deleted.';
  removal.todos.each(function() {
    clearTimeout(this.timer);
    this.deleted = true; // before detaching, which fires focusout
  });
  rows.removeClass('selected').detach();
  removals.push(removal);
  removal.timer = setTimeout(function() { finishRemoval(removal); }, 7000);
  showUndo();
  refreshRows();
}

function showUndo() {
  var last = removals[removals.length - 1];
  var more = removals.length > 1 ? ' ' + removals.length + ' changes can be undone.' : '';
  if (!last) return;
  showMessage(last.text + more, 'Undo', undoRemoval);
  undoShown = true;
}

// Undo the latest removal. Earlier ones can be undone after it.
function undoRemoval() {
  var r = removals.pop();
  if (!r) return;
  clearTimeout(r.timer);
  putBack(r, r.todos);
  if (r.onUndo) r.onUndo();
  r.todos.each(function() { saveTask($(this)); });
  showUndo();
}

function putBack(r, todos) {
  todos.each(function() { this.deleted = this.gone = false; });
  if (r.next.length && $.contains(document, r.next[0])) r.next.before(todos.parent());
  else if (r.prev.length && $.contains(document, r.prev[0])) r.prev.after(todos.parent());
  else r.list.append(todos.parent());
  refreshRows();
}

function finishRemoval(r) {
  removals.splice($.inArray(r, removals), 1);
  clearTimeout(r.timer);
  if (undoShown) { // leave any other message up
    hideMessage();
    showUndo();
  }
  $(r.todos.get().reverse()).each(function() { // subtasks before their parent
    this.gone = true;
    deleteTask($(this), r);
  });
}

function deleteTask(todo, removal) {
  var id = todo.attr('id');
  if (!id) return; // never saved, or saveTask deletes it once it has an id
  api('DELETE', '/' + id, null, null, function(status) {
    if (status === 404) return; // already deleted
    if (removal) putBack(removal, todo);
    showFailure('Could not delete that task.', status);
  });
}

// Join a row's text, notes and date onto the one before it, and remove it.
function mergeRows(target, source) {
  if (subtaskRows(source).length) {
    showMessage('That task has subtasks, so it can’t be joined.', null, null, 4000);
    return;
  }
  var before = current(target), from = current(source);
  setValues(target, {
    title: before.title + from.title,
    notes: before.notes + (before.notes && from.notes ? '\n' : '') + from.notes,
    due: before.due || from.due
  });
  target.setCursorPosition(before.title.length);
  saveTask(target);
  removeRow(source, 'Tasks joined.', function() {
    setValues(target, before);
    saveTask(target);
  });
}

function setValues(todo, values) {
  var row = todo.parent();
  todo.val(values.title);
  row.find('.notes').val(values.notes);
  row.find('.due').val(values.due);
  renderMeta(row);
  autosize(todo);
}

// Last chance as the page closes: requests that outlive it.
function flush() {
  if (!signedIn()) return;
  var headers = { 'Authorization': 'Bearer ' + gapi.auth.getToken().access_token, 'Content-Type': 'application/json' };
  var url = 'https://www.googleapis.com/tasks/v1/lists/' + TASK_LIST + '/tasks';
  $('.todo').each(function() {
    var el = this, todo = $(el), id = todo.attr('id'), sent = current(todo);
    if (!isUnsaved(todo) || (el.saving && !id)) return;
    clearTimeout(el.timer);
    el.saving = true;
    fetch(url + (id ? '/' + id : placement(todo)), { method: id ? 'PATCH' : 'POST', headers: headers, keepalive: true, body: JSON.stringify(changes(todo)) })
      .then(function(r) { if (!r.ok) throw r; return r.json(); })
      .then(function(task) { todo.attr('id', task.id); el.saved = sent; })
      .catch(function() {})
      .then(function() { el.saving = false; });
  });
  $.each(removals.splice(0), function(i, r) {
    clearTimeout(r.timer);
    $(r.todos.get().reverse()).each(function() {
      this.gone = true;
      if (this.id) fetch(url + '/' + this.id, { method: 'DELETE', headers: headers, keepalive: true }).catch(function() {});
    });
  });
  if (undoShown) hideMessage();
}

$(window).on('pagehide', flush);

function newTask() {
  if (!signedIn()) return handleAuthClick();
  var row = taskRow({});
  $('#claire').prepend(row);
  refreshRows();
  row.children('.todo').focus();
}
