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

function showMessage(text, button, onClick, ms) {
  clearTimeout(messageTimer);
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
  $('#message').hide();
}

// Google's access runs out after about an hour, which shows up as a 401.
function showFailure(text, status, retry) {
  if (status === 401) showMessage(text + ' Please log in again.', 'Log in', handleAuthClick);
  else showMessage(text, retry && 'Retry', retry, retry ? 0 : 6000);
}

function listTasks() {
  if (tasksLoaded) return saveAll(); // logged in again: save what couldn't be saved
  getPage([], '');
}

// Google returns at most 100 tasks at a time.
function getPage(tasks, pageToken) {
  var query = '?maxResults=100' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
  api('GET', query, null, function(result) {
    if (tasksLoaded) return; // a late silent sign-in must not list them twice
    tasks = tasks.concat((result && result.items) || []);
    if (result && result.nextPageToken) return getPage(tasks, result.nextPageToken);
    showTasks(tasks);
  }, showLogIn);
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
  tasksLoaded = true;
  showStatus('');
  $('#claire').append($.map(inOrder(tasks), taskRow));
  updateToDoCount();
  toggleToDoCheckboxes();
  if (!tasks.length) $(document.body).append($('<p>No tasks</p>'));
}

// Tick or untick. If Google refuses, put the box back as it was.
function setCompleted(checkbox) {
  var todo = checkbox.siblings('.todo');
  var done = checkbox.prop('checked');
  todo.toggleClass('checked', done);
  if (!todo.attr('id')) return; // saveTitle sends it once the task exists
  var body = done ? { status: 'completed' } : { status: 'needsAction', completed: null };
  api('PATCH', '/' + todo.attr('id'), body, null, function(status) {
    checkbox.prop('checked', !done);
    todo.toggleClass('checked', !done);
    showFailure('Could not update that task.', status);
  });
}

// Set the title with .val() so quotes and HTML in it are treated as text.
function taskRow(task) {
  var done = task.status === 'completed';
  var todo = $('<input type="text" class="todo"/>').toggleClass('checked', done).val(task.title || '');
  if (task.id) todo.attr('id', task.id);
  todo[0].savedTitle = task.title || '';
  todo[0].parentTask = task.parent;
  return $('<li></li>').append(todo, $('<input type="checkbox"/>').prop('checked', done));
}

// State lives on the element, not in .data():
//   savedTitle  the title Google has      saving   a save is in progress
//   deleted     hidden, can be undone     gone     no longer undoable
function isUnsaved(todo) {
  var el = todo[0];
  if (!el || el.deleted) return false;
  return todo.val() !== (el.savedTitle || '');
}

// The nearest row above that Google knows about, or undefined.
function savedRowAbove(todo) {
  return todo.parent().prevAll().children('.todo').filter('[id]').first()[0];
}

// Where to create a task: after the row above it, or at the top.
function placement(todo) {
  var above = savedRowAbove(todo);
  if (!above) return '';
  return '?previous=' + encodeURIComponent(above.id) +
    (above.parentTask ? '&parent=' + encodeURIComponent(above.parentTask) : '');
}

// A new row waits for a new row above it, so that they are created in order.
function mustWait(todo) {
  var above = todo.parent().prev().children('.todo');
  if (!above[0] || above.attr('id') || above[0].failed || !isUnsaved(above)) return false;
  saveTitle(above);
  return true;
}

// Save a row's text: create the task the first time, then update its title.
function saveTitle(todo) {
  var el = todo[0];
  if (!el) return;
  clearTimeout(el.timer);
  if (el.saving || !isUnsaved(todo)) return;
  var title = todo.val();
  var id = todo.attr('id');
  if (!id && mustWait(todo)) return saveSoon(todo);
  el.saving = true;
  api(id ? 'PATCH' : 'POST', id ? '/' + id : placement(todo), { title: title }, function(result) {
    el.saving = el.failed = false;
    el.savedTitle = title;
    if (!id) {
      todo.attr('id', result.id);
      el.parentTask = result.parent;
      if (el.gone) return deleteTask(todo);
      var box = todo.siblings('input[type=checkbox]');
      if (box.prop('checked')) setCompleted(box);
    }
    saveTitle(todo); // the text may have changed while saving
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
  el.timer = setTimeout(function() { saveTitle(todo); }, 800);
}

function saveAll() {
  $('.todo').each(function() { saveTitle($(this)); });
}

var removals = []; // rows hidden but not yet deleted from Google, oldest first

// Hide a row now and delete it from Google in a few seconds, unless undone.
function removeRow(todo, text, onUndo) {
  var row = todo.parent();
  var removal = { todo: todo, row: row, text: text, next: row.next(), prev: row.prev(), list: row.parent(), onUndo: onUndo };
  clearTimeout(todo[0].timer);
  todo[0].deleted = true; // before detaching, which fires focusout
  row.removeClass('selected').detach();
  removals.push(removal);
  removal.timer = setTimeout(function() { finishRemoval(removal); }, 7000);
  showUndo();
  updateToDoCount();
}

function showUndo() {
  var last = removals[removals.length - 1];
  var more = removals.length > 1 ? ' ' + removals.length + ' changes can be undone.' : '';
  if (last) showMessage(last.text + more, 'Undo', undoRemoval);
}

// Undo the latest removal. Earlier ones can be undone after it.
function undoRemoval() {
  var r = removals.pop();
  if (!r) return;
  clearTimeout(r.timer);
  putBack(r);
  if (r.onUndo) r.onUndo();
  saveTitle(r.todo);
  showUndo();
}

function putBack(r) {
  r.todo[0].deleted = r.todo[0].gone = false;
  if (r.next.length && $.contains(document, r.next[0])) r.next.before(r.row);
  else if (r.prev.length && $.contains(document, r.prev[0])) r.prev.after(r.row);
  else r.list.append(r.row);
  updateToDoCount();
  toggleToDoCheckboxes();
}

function finishRemoval(r) {
  removals.splice($.inArray(r, removals), 1);
  clearTimeout(r.timer);
  if ($('#message button').text() === 'Undo') { // leave any other message up
    hideMessage();
    showUndo();
  }
  r.todo[0].gone = true;
  deleteTask(r.todo, r);
}

function deleteTask(todo, removal) {
  var id = todo.attr('id');
  if (!id) return; // never saved, or saveTitle deletes it once it has an id
  api('DELETE', '/' + id, null, null, function(status) {
    if (status === 404) return; // already deleted elsewhere
    if (removal) putBack(removal);
    showFailure('Could not delete that task.', status);
  });
}

// Join a row's text onto the one before it, and remove it.
function mergeRows(target, source) {
  var before = target.val();
  target.val(before + source.val());
  target.setCursorPosition(before.length);
  saveTitle(target);
  removeRow(source, 'Tasks joined.', function() {
    target.val(before);
    saveTitle(target);
  });
}

// Last chance as the page closes: requests that outlive it.
function flush() {
  if (!signedIn()) return;
  var headers = { 'Authorization': 'Bearer ' + gapi.auth.getToken().access_token, 'Content-Type': 'application/json' };
  var url = 'https://www.googleapis.com/tasks/v1/lists/' + TASK_LIST + '/tasks';
  $('.todo').each(function() {
    var el = this, todo = $(el), id = todo.attr('id'), title = todo.val();
    if (!isUnsaved(todo) || (el.saving && !id)) return;
    clearTimeout(el.timer);
    el.saving = true;
    fetch(url + (id ? '/' + id : placement(todo)), { method: id ? 'PATCH' : 'POST', headers: headers, keepalive: true, body: JSON.stringify({ title: title }) })
      .then(function(r) { if (!r.ok) throw r; return r.json(); })
      .then(function(task) { todo.attr('id', task.id); el.savedTitle = title; })
      .catch(function() {})
      .then(function() { el.saving = false; });
  });
  $.each(removals.splice(0), function(i, r) {
    clearTimeout(r.timer);
    r.todo[0].gone = true;
    var id = r.todo.attr('id');
    if (id) fetch(url + '/' + id, { method: 'DELETE', headers: headers, keepalive: true }).catch(function() {});
  });
  if ($('#message button').text() === 'Undo') hideMessage();
}

$(window).on('pagehide', flush);

function newTask() {
  if (!signedIn()) return handleAuthClick();
  var row = taskRow({});
  $('#claire').prepend(row);
  row.children().first().focus();
}
