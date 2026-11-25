var API = 'https://tasks.googleapis.com/tasks/v1/';
var tasksLoaded = false;
var session = 0; // goes up on log out or changing list, so late answers are ignored

function checkAuth() {
  if (loggedOut()) return showLogIn();
  auth.silent(handleAuthResult);
}

function handleAuthResult(ok) {
  if (!ok) return showLogIn();
  if (tasksLoaded) return saveAll(); // logged in again: save what couldn't be saved
  showStatus('Loading\u2026');
  listTasks();
}

function handleAuthClick() {
  auth.login(function(ok, reason) {
    if (ok) loggedOut(false);
    handleAuthResult(ok);
    if (!ok) showMessage('Google didn\u2019t log you in' + (reason ? ' (' + reason + ').' : '.'), null, null, 10000);
  }, loggedOut());
}

// Whether you chose to log out, so a refresh doesn't log you straight back in.
// Pass true or false to set it.
var loggedOutHere = false;

function loggedOut(value) {
  try {
    if (value === true) localStorage.setItem('tabandtick-logged-out', '1');
    if (value === false) localStorage.removeItem('tabandtick-logged-out');
    return localStorage.getItem('tabandtick-logged-out') === '1';
  } catch (e) { // storage is blocked
    if (value !== undefined) loggedOutHere = value;
    return loggedOutHere;
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
  return !!auth.token();
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

// Calls Google. done(result) on success, failed(status) if not; status is undefined
// when Google couldn't be reached. A refused token is replaced and tried once more.
function send(method, path, body, done, failed, again) {
  var started = session;
  var options = { method: method, headers: { 'Authorization': 'Bearer ' + auth.token() } };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  fetch(API + path, options).then(function(response) {
    return response.text().then(function(text) {
      return { ok: response.ok, status: response.status, result: response.ok && text ? JSON.parse(text) : null };
    });
  }).catch(function(error) {
    return { ok: false, error: error };
  }).then(function(answer) {
    if (started !== session) return;
    if (answer.ok) {
      if (done) done(answer.result);
      return;
    }
    if (answer.status === 401 && !again) {
      auth.expired(function(ok) {
        if (started !== session) return;
        if (ok) send(method, path, body, done, failed, true);
        else if (failed) failed(401);
      });
      return;
    }
    console.error(method + ' failed', answer.status || answer.error);
    if (failed) failed(answer.status);
  });
}

// Calls Google about a task in the list on screen.
function api(method, path, body, done, failed) {
  send(method, 'lists/' + encodeURIComponent(listId) + '/tasks' + path, body, done, failed);
}

// Google's access runs out after about an hour, which shows up as a 401.
function showFailure(text, status, retry) {
  if (status === 401) showMessage(text + ' Please log in again.', 'Log in', handleAuthClick);
  else showMessage(text, retry && 'Retry', retry, retry ? 0 : 6000);
}

// ---- Lists

var listId = remembered() || '@default'; // the list on screen
var lists = [];

function remembered(id) {
  try {
    if (id !== undefined) localStorage.setItem('tabandtick-list', id);
    return localStorage.getItem('tabandtick-list');
  } catch (e) { // storage is blocked
    return null;
  }
}

function listTasks() {
  fetchAll('showCompleted=false', function(tasks) {
    if (tasksLoaded) return; // a late silent sign-in must not list them twice
    tasksLoaded = true;
    showStatus('');
    $('body').addClass('signed-in');
    showTasks(tasks);
    loadTicked();
    loadLists();
  }, function(status) {
    if (status === 404 && listId !== '@default') { // that list has been deleted
      listId = '@default';
      remembered('@default');
      return listTasks();
    }
    showLogIn();
    showMessage('Logged in, but your tasks couldn\u2019t be loaded (' + (status || 'no connection') + ').', 'Retry', checkAuth);
  });
}

function loadLists() {
  send('GET', 'users/@me/lists?maxResults=100', null, function(result) {
    lists = (result && result.items) || [];
    if (listId !== '@default') return showLists();
    send('GET', 'users/@me/lists/@default', null, function(list) {
      if (listId === '@default') listId = list.id; // same list, by its own name
      showLists();
    });
  });
}

function currentList() {
  return $.grep(lists, function(list) { return list.id === listId; })[0];
}

function showLists() {
  $('#lists').empty().append($.map(lists, function(list) {
    return $('<li></li>').append($('<button type="button"></button>')
      .attr({ 'data-list': list.id, 'aria-current': list.id === listId ? 'true' : null })
      .append($('<span class="name"></span>').text(list.title), $('<span class="count"></span>').text(list.count === undefined ? '' : list.count)));
  }));
  var list = currentList();
  if (list && !$('#list-title').is(':focus')) $('#list-title').val(list.title);
  updateToDoCount();
  $.each(lists.slice(0, 15), function(i, other) {
    if (other.id === listId || other.count !== undefined) return;
    fetchAll('showCompleted=false', function(tasks) {
      other.count = tasks.length;
      $('#lists [data-list]').filter(function() { return $(this).attr('data-list') === other.id; }).find('.count').text(other.count);
    }, null, null, null, other.id);
  });
}

// Wait for everything to be saved, then go on.
function settle(anyway, done) {
  saveAll();
  var tries = 0;
  (function wait() {
    if (!anyUnsaved()) return done();
    if (tries++ < 20) return setTimeout(wait, 250);
    showMessage('Some changes couldn\u2019t be saved.', anyway, done);
  })();
}

function anyUnsaved() {
  return moves.length > 0 || $('.todo').filter(function() { return this.saving || isUnsaved($(this)); }).length > 0;
}

function clearTasks() {
  undoStack = [];
  flush(); // finishes any deletes
  session++;
  moves = [];
  tasksLoaded = false;
  doneShown = 0;
  doneWaiting = [];
  selected = $();
  hideMessage();
  closeMenu();
  $('#claire, #done-list').empty();
  $('#done').removeClass('open').hide();
  $('#done-toggle').attr('aria-expanded', 'false');
  refreshRows();
}

function switchList(id) {
  $('body').removeClass('side-open');
  if (id === listId) return;
  settle('Switch anyway', function() {
    clearTasks();
    listId = id;
    remembered(id);
    var list = currentList();
    $('#list-title').val(list ? list.title : '');
    showStatus('Loading\u2026');
    listTasks();
  });
}

function createList(title) {
  send('POST', 'users/@me/lists', { title: title }, function(list) {
    lists.push(list);
    switchList(list.id);
  }, function(status) {
    showFailure('Could not create that list.', status);
  });
}

function renameList(title) {
  var list = currentList();
  if (!list) return;
  if (!title || title === list.title) return $('#list-title').val(list.title);
  send('PATCH', 'users/@me/lists/' + encodeURIComponent(list.id), { title: title }, function() {
    list.title = title;
    showLists();
  }, function(status) {
    $('#list-title').val(list.title);
    showFailure('Could not rename that list.', status);
  });
}

function logOut() {
  settle('Log out anyway', endSession);
}

function endSession() {
  clearTasks();
  loggedOut(true);
  auth.logout();
  lists = [];
  listId = '@default';
  remembered('@default');
  $('#lists').empty();
  $('#list-title').val('');
  $('body').removeClass('signed-in side-open');
  showLogIn();
}

// ---- Tasks

// Google returns at most 100 tasks at a time.
function fetchAll(query, done, failed, tasks, pageToken, list) {
  var path = 'lists/' + encodeURIComponent(list || listId) + '/tasks?maxResults=100&' + query;
  send('GET', path + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), null, function(result) {
    var all = (tasks || []).concat((result && result.items) || []);
    if (result && result.nextPageToken) return fetchAll(query, done, failed, all, result.nextPageToken, list);
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
  var ticked = $('#claire li').filter(function() { return $(this).children('.todo').hasClass('checked'); }).detach();
  $('#claire').empty().append($.map(inOrder(tasks), taskRow));
  $('#claire .todo').each(function() { // not indented if its parent isn't here
    if (this.parentTask && !document.getElementById(this.parentTask)) $(this).parent().removeClass('subtask');
  });
  ticked.each(function() {
    var todo = $(this).children('.todo');
    if (!document.getElementById(todo.attr('id')) && openParent(todo).length) placeSubtask(todo);
  });
  $('#done').show();
  refreshRows();
}

// The open task that this one is a subtask of, if it is on screen.
function openParent(todo) {
  var id = todo[0].parentTask;
  return $('#claire .todo').not('.checked').filter(function() { return id && this.id === id; });
}

// Put a row among its parent's other subtasks.
function placeSubtask(todo) {
  var parent = openParent(todo), row = todo.parent().addClass('subtask');
  var before = subtaskRows(parent).not(row).filter(function() {
    return ($(this).children('.todo')[0].position || '') < (todo[0].position || '');
  }).last();
  (before.length ? before : parent.parent()).after(row);
}

// Ticked subtasks stay under their parent until it is done too. Returns the tasks
// that don't belong under an open one.
function placeTicked(tasks) {
  var rest = $.grep(tasks, function(task) {
    if (task.status !== 'completed' || document.getElementById(task.id) || isRemoved(task.id)) return false;
    if (!task.parent) return true;
    var row = taskRow(task), todo = row.children('.todo');
    if (!openParent(todo).length) return true;
    placeSubtask(todo);
    return false;
  });
  refreshRows();
  return rest;
}

// Google can't be asked for these alone, so look at what has changed in a year.
function loadTicked() {
  if (!$('#claire li').length) return;
  fetchAll('showCompleted=true&showHidden=true&updatedMin=' + encodeURIComponent(new Date(Date.now() - 365 * 864e5).toISOString()), function(tasks) {
    if (tasksLoaded) placeTicked(tasks);
  });
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
      if ($.inArray(this.id, open) >= 0) row.addClass('open');
      if (id && this.id === id) row.find(field).setCursorPosition(start || 0);
    });
    loadTicked();
  });
}

function busy() {
  return removals.length > 0 || moves.length > 0 || $('#claire .todo').filter(function() {
    return !this.id || this.saving || isUnsaved($(this));
  }).length > 0;
}

// ---- Completed tasks, loaded only when asked for, newest first, ten at a time

var doneDays = [30, 365, 0]; // how far back each request goes; 0 is everything
var doneShown = 0;           // how many of those have been made
var doneWaiting = [];        // loaded but not shown yet

function toggleDone() {
  var open = !$('#done').hasClass('open');
  $('#done').toggleClass('open', open);
  $('#done-toggle').attr('aria-expanded', String(open));
  if (open && !doneShown) loadDone();
  refreshRows();
}

function loadDone() {
  if (doneWaiting.length >= 10 || doneShown === doneDays.length) return showDone();
  var days = doneDays[doneShown];
  $('#done-more').prop('disabled', true).text('Loading\u2026').show();
  // Not completedMin: subtasks completed along with their parent may have no date.
  var since = days ? '&updatedMin=' + encodeURIComponent(new Date(Date.now() - days * 864e5).toISOString()) : '';
  fetchAll('showCompleted=true&showHidden=true' + since, function(tasks) {
    doneShown++;
    doneWaiting = inDoneOrder(placeTicked(tasks));
    loadDone();
  }, function(status) {
    $('#done-more').prop('disabled', false).text('Try again').show();
    showFailure('Could not load completed tasks.', status);
  });
}

function isRemoved(id) {
  return removals.some(function(r) { return r.todos.is(function() { return this.id === id; }); });
}

function doneDate(task) {
  return task.completed || task.updated || '';
}

// Newest first, with subtasks straight after their parent if it is there too.
function inDoneOrder(tasks) {
  var byId = {}, children = {}, top = [];
  $.each(tasks, function(i, task) { byId[task.id] = task; });
  $.each(tasks, function(i, task) {
    if (byId[task.parent]) (children[task.parent] = children[task.parent] || []).push(task);
    else top.push(task);
  });
  top.sort(function(a, b) { return doneDate(a) < doneDate(b) ? 1 : doneDate(a) > doneDate(b) ? -1 : 0; });
  return $.map(top, function(task) {
    return [task].concat((children[task.id] || []).sort(function(a, b) {
      return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
    }));
  });
}

function showDone() {
  var next = doneWaiting.splice(0, 10);
  while (next.length && doneWaiting.length && doneWaiting[0].parent && next.some(function(task) { return task.id === doneWaiting[0].parent; })) {
    next.push(doneWaiting.shift()); // don't split a family
  }
  $('#done-list').append($.map(next, function(task) {
    return document.getElementById(task.id) ? null : taskRow(task);
  }));
  var more = doneWaiting.length > 0 || doneShown < doneDays.length;
  $('#done-more').prop('disabled', false).text('Load more').toggle(more);
  sortDone();
  $('#done-none').toggle(!$('#done-list li').length);
}

// The total is only known once everything has been loaded.
function updateDoneCount() {
  var all = doneShown === doneDays.length;
  $('#done-toggle').text('Completed' + (all ? ' (' + ($('#done-list li').length + doneWaiting.length) + ')' : ''));
}

function sortDone() {
  var rows = $('#done-list li'), ids = {}, top = [];
  function el(row) { return $(row).children('.todo')[0]; }
  rows.each(function() { ids[el(this).id] = true; });
  rows.each(function() {
    var child = !!(el(this).parentTask && ids[el(this).parentTask]);
    $(this).toggleClass('subtask', child);
    if (!child) top.push(this);
  });
  top.sort(function(a, b) {
    var x = el(a).completedAt || '', y = el(b).completedAt || '';
    return x < y ? 1 : x > y ? -1 : 0;
  });
  $.each(top, function(i, row) {
    var id = el(row).id;
    $('#done-list').append(row, id ? rows.filter('.subtask').filter(function() { return el(this).parentTask === id; }) : null);
  });
  if (rows.length) $('#done-none').hide();
  refreshRows();
}

// Tick or untick. The row moves between the lists once Google agrees, except that
// a ticked subtask stays with its open parent.
function setCompleted(checkbox, after, quiet) {
  var todo = checkbox.siblings('.todo');
  var row = todo.parent();
  var done = checkbox.prop('checked');
  var id = todo.attr('id');
  todo.toggleClass('checked', done);
  if (!id) return; // saveTask sends it once the task exists
  api('PATCH', '/' + id, done ? { status: 'completed' } : { status: 'needsAction', completed: null }, function(result) {
    if (checkbox.prop('checked') !== done) return; // changed again since
    todo[0].completedAt = done ? (result && result.completed) || new Date().toISOString() : undefined;
    if (todo[0].deleted) return;
    var here = row.parent().is('#claire');
    if (here && (!done || openParent(todo).length)) {
      refreshRows();
      if (done) offerUntick(checkbox, [], quiet);
    } else if (done) {
      var subtasks = subtaskRows(todo).children('.todo');
      row.removeClass('selected');
      $('#done-list').prepend(row, subtasks.filter('.checked').parent().removeClass('selected'));
      sortDone();
      var open = subtasks.not('.checked').get();
      if (open.length) followSubtasks(checkbox, open, quiet);
      else offerUntick(checkbox, [], quiet);
    } else {
      var along = subtaskRows(todo);
      row.removeClass('selected');
      if (openParent(todo).length) placeSubtask(todo);
      else $('#claire').prepend(row.removeClass('subtask'), along.addClass('subtask'));
      sortDone();
      reload(); // puts it back in its place
    }
    renderMeta(row);
    if (!done && !quiet) canUndo(function() { return live(todo).length && !live(todo).hasClass('checked'); }, function() { undoTick([todo], true); });
    if (after) after();
  }, function(status) {
    checkbox.prop('checked', !done);
    todo.toggleClass('checked', !done);
    showFailure('Could not update that task.', status);
  });
}

function offerUntick(checkbox, subtasks, quiet) {
  var todos = $.map([checkbox[0]].concat(subtasks), function(box) { return $(box).siblings('.todo'); });
  function can() { return live(todos[0]).hasClass('checked'); }
  function undo() { undoTick(todos, false); }
  if (quiet) return;
  canUndo(can, undo);
  if (removals.length) return; // keep the button for a delete
  var count = subtasks.length;
  showMessage('Task ' + (count ? 'and ' + count + ' subtask' + (count > 1 ? 's ' : ' ') : '') + 'completed.', 'Undo', function() {
    if (can()) undo();
  }, 7000);
}

// Google decides whether completing a task completes its subtasks, so ask it.
function followSubtasks(checkbox, subtasks, quiet) {
  var left = subtasks.length, moved = [];
  function next() {
    if (--left) return;
    if (moved.length) sortDone();
    offerUntick(checkbox, moved, quiet);
    reload();
  }
  $.each(subtasks, function(i, el) {
    var todo = $(el), row = todo.parent();
    if (!el.id) return next();
    api('GET', '/' + el.id, null, function(task) {
      var open = row.parent().is('#claire') && !el.deleted;
      if (open && task && task.status === 'completed') {
        saveTask(todo);
        el.completedAt = doneDate(task);
        todo.addClass('checked');
        moved.push(todo.siblings('input[type=checkbox]').prop('checked', true)[0]);
        $('#done-list').append(row.removeClass('selected'));
        renderMeta(row);
      }
      next();
    }, next);
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
    .val(text(task.title));
  var notes = $('<textarea class="notes" rows="3" placeholder="Notes" aria-label="Notes"></textarea>').val(text(task.notes));
  var due = $('<input type="date" class="due" aria-label="Due date" min="2000-01-01" max="2999-12-31"/>').val((task.due || '').slice(0, 10));
  var row = $('<li></li>').toggleClass('subtask', !!task.parent).append(
    $('<span class="handle" title="Drag to move" aria-hidden="true">&#8942;&#8942;</span>'),
    $('<input type="checkbox" aria-label="Completed"/>').prop('checked', done),
    todo,
    $('<button type="button" class="more" aria-label="Task options" aria-haspopup="true" aria-expanded="false">&#8942;</button>'),
    $('<div class="meta"><span class="when"></span><span class="preview"></span></div>'),
    $('<div class="details"></div>').append(notes, $('<label>Due </label>').append(due), $('<button type="button" class="clear-due">Clear date</button>')),
    $('<div class="menu" role="menu"></div>').append($.map([
      ['details', 'Notes and due date'], ['subtask', 'Add a subtask'], ['indent', 'Make subtask'], ['outdent', 'Move out'],
      ['top', 'Move to top'], ['up', 'Move up'], ['down', 'Move down'], ['delete', 'Delete']
    ], function(item) {
      return $('<button type="button" role="menuitem"></button>').attr('data-move', item[0]).text(item[1]);
    }))
  );
  if (task.id) todo.attr('id', task.id);
  todo[0].parentTask = task.parent;
  todo[0].position = task.position;
  todo[0].completedAt = done ? doneDate(task) : undefined;
  todo[0].saved = { title: todo.val(), notes: notes.val(), due: due.val() };
  todo[0].lastTitle = todo.val();
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
  row.children('.handle').toggleClass('off', row.children('.todo').hasClass('checked'));
}

function subtaskRows(todo) {
  var id = todo.attr('id');
  return todo.closest('ul').find('.todo').filter(function() { return id && this.parentTask === id; }).parent();
}

// A completed task whose subtasks are still open: deleting it could take them too.
function hasOpenSubtasks(todo) {
  var id = todo.attr('id');
  if (!todo.closest('#done-list').length) return false;
  if (!$('#claire .todo').filter(function() { return id && this.parentTask === id; }).length) return false;
  showMessage('That task still has open subtasks, so it can\u2019t be removed.', null, null, 4000);
  return true;
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
  var above = siblingAbove(todo, function(el) { return el.id && !$(el).hasClass('checked'); }); // Google hides ticked ones
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

// ---- Cmd+Z. Each entry has run(), and can() to say whether it still makes sense.

var undoStack = [];
var typed = false;   // typing since the last entry, which the browser undoes itself
var undoing = false; // so that undoing isn't itself added

function canUndo(can, run) {
  if (undoing) return;
  typed = false;
  undoStack.push({ can: can, run: run });
  if (undoStack.length > 100) undoStack.shift();
}

// Undo the latest thing that can be. Returns whether anything was.
function undoLast() {
  while (undoStack.length) {
    var entry = undoStack.pop();
    if (!entry.can()) continue;
    undoing = true;
    if ($('#message button').text() === 'Undo') hideMessage();
    try {
      entry.run();
      showUndo(); // for any deletes still waiting
    } finally {
      undoing = false;
    }
    return true;
  }
  return false;
}

// The row on screen for a task, as refreshing the list makes new ones.
function live(todo) {
  var el = todo && todo[0];
  if (!el || el.gone) return $();
  if ($.contains(document, el)) return todo;
  return el.id && !el.deleted ? $('ul.list .todo').filter(function() { return this.id === el.id; }) : $();
}

function undoTick(todos, done) {
  var boxes = $.map(todos, function(todo) { return live(todo).siblings('input[type=checkbox]').get(); });
  if (!boxes.length) return;
  $(boxes[0]).prop('checked', done);
  setCompleted($(boxes[0]), function() { // then its subtasks, which come back with it
    $.each(boxes.slice(1), function(i, box) {
      $(box).prop('checked', done);
      setCompleted($(box), null, true);
    });
  }, true);
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
  canUndo(function() { return removals[removals.length - 1] === removal; }, undoRemoval);
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
  if (r.list.is('#done-list')) sortDone();
  else refreshRows();
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
  if (hasOpenSubtasks(source)) return;
  if (subtaskRows(source).length) {
    showMessage('That task has subtasks, so it can’t be joined.', null, null, 4000);
    return;
  }
  var before = current(target), from = current(source);
  if (!from.title && !from.notes && !from.due) return removeBlank(source, target, before.title.length);
  setValues(target, {
    title: before.title + from.title,
    notes: before.notes + (before.notes && from.notes ? '\n' : '') + from.notes,
    due: before.due || from.due
  });
  source[0].deleted = true; // moving focus mustn't save it first
  target.setCursorPosition(before.title.length);
  saveTask(target);
  removeRow(source, 'Tasks joined.', function() {
    setValues(target, before);
    saveTask(target);
  });
}

// Delete a row with nothing in it. Undo brings back the title it had.
function removeBlank(todo, next, caret) {
  var el = todo[0];
  if (!todo.attr('id') && !el.saving) { // never saved, so there's nothing to undo
    todo.parent().remove();
    refreshRows();
  } else {
    var title = el.lastTitle || '';
    removeRow(todo, null, function() {
      setValues(todo, $.extend(current(todo), { title: title }));
    });
  }
  next.setCursorPosition(caret);
}

function setValues(todo, values) {
  var row = todo.parent();
  todo.val(values.title);
  row.find('.notes').val(values.notes);
  row.find('.due').val(values.due);
  renderMeta(row);
  autosize(todo);
}

// ---- Moving. Rows are put in place first, then Google is told one move at a time.

var moves = [];

function moveTask(todo) {
  moves.push(todo);
  if (moves.length === 1) nextMove();
}

function nextMove() {
  var todo = moves[0];
  if (!todo) return;
  var id = todo.attr('id');
  function done() {
    moves.shift();
    nextMove();
  }
  if (!id || todo[0].deleted) return done(); // a new task is created in its place
  api('POST', '/' + id + '/move' + placement(todo), null, done, function(status) {
    moves = [];
    showFailure('Could not move that task.', status);
    reload(); // back to how Google has it
  });
}

// Put a row, with its subtasks, before another row (or last) under a parent (or none).
function place(todo, before, parent) {
  var rows = todo.parent().add(subtaskRows(todo));
  var was = { above: todo.parent().prev()[0], parent: todo[0].parentTask };
  var above = todo.parent().prev().children('.todo'), below = rows.last().next().children('.todo');
  if (before && before.length) before.before(rows);
  else $('#claire').append(rows);
  todo[0].parentTask = parent;
  todo.parent().toggleClass('subtask', !!parent);
  refreshRows();
  if (was.above === todo.parent().prev()[0] && was.parent === parent) return;
  moveTask(todo);
  canUndo(function() { return live(todo).closest('#claire').length; }, function() {
    var back = live(above).closest('#claire li'), next = live(below).closest('#claire li');
    var row = live(todo);
    place(row, next.length ? next : back.length ? back.nextAll('li').not(row.parent().add(subtaskRows(row))).first() : above.length ? $() : $('#claire li').first(), was.parent);
    row.focus();
  });
}

// The rows of a top-level task and its subtasks, in order.
function family(row) {
  return row.add(row.nextUntil('li:not(.subtask)'));
}

// Google only lets a completed task move to the top level, with no place in it, so
// moving one out of its family puts it among the completed tasks.
function moveOutTicked(todo) {
  var row = todo.parent(), el = todo[0], parent = el.parentTask, list = row.parent();
  if (!parent || !el.id) return false;
  el.parentTask = undefined;
  row.removeClass('selected');
  $('#done-list').append(row);
  sortDone();
  showMessage('Moved to Completed.', null, null, 4000);
  api('POST', '/' + el.id + '/move', null, null, function(status) {
    el.parentTask = parent;
    if (list.is('#claire') && openParent(todo).length) placeSubtask(todo);
    sortDone();
    showFailure('Could not move that task.', status);
  });
  return true;
}

function moveRow(todo, how) {
  var row = todo.parent();
  if (how === 'outdent' && todo.hasClass('checked') && row.hasClass('subtask')) return moveOutTicked(todo);
  if (!row.parent().is('#claire') || todo.hasClass('checked')) return;
  var sub = row.hasClass('subtask');
  var caret = document.activeElement === todo[0] ? todo[0].selectionStart : null;
  var other, above, moved = false;
  if (how === 'subtask') return addSubtask(todo);
  if (how === 'top') {
    other = sub ? row.prevUntil('li:not(.subtask)').last() : row.siblings().first();
    if (other.length && other.index() < row.index()) place(todo, other, todo[0].parentTask);
  } else if (how === 'up') {
    other = sub ? row.prev('.subtask') : row.prevAll('li:not(.subtask)').first();
    if (other.length) place(todo, other, todo[0].parentTask);
  } else if (how === 'down') {
    other = sub ? row.next('.subtask') : family(row).last().next();
    if (other.length) place(todo, (sub ? other : family(other).last()).next(), todo[0].parentTask);
  } else if (how === 'indent' && !sub) {
    above = row.prev().children('.todo');
    if (!above.length) return;
    if (family(row).length > 1) {
      showMessage('That task has subtasks, so it can\u2019t become one.', null, null, 4000);
      return true; // dealt with: don't move focus as well
    }
    var parent = row.prev().hasClass('subtask') ? above[0].parentTask : above.attr('id');
    if (!parent) return;
    place(todo, row.next(), parent);
    moved = true;
  } else if (how === 'outdent' && sub) {
    place(todo, row.nextAll('li:not(.subtask)').first(), undefined);
    moved = true;
  }
  if (caret !== null) todo.setCursorPosition(caret);
  return moved;
}

function addSubtask(todo) {
  var id = todo.attr('id');
  if (todo.parent().hasClass('subtask')) return; // Google only has one level
  if (!id) return showMessage(todo.val() ? 'Still saving that task. Try again in a moment.' : 'Give that task a title first.', null, null, 4000);
  var row = taskRow({ parent: id });
  family(todo.parent()).last().after(row);
  refreshRows();
  row.children('.todo').focus();
}

// Last chance as the page closes: requests that outlive it.
function flush() {
  if (!signedIn()) return;
  var headers = { 'Authorization': 'Bearer ' + auth.token(), 'Content-Type': 'application/json' };
  var url = API + 'lists/' + encodeURIComponent(listId) + '/tasks';
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
  $.each(moves.slice(1), function(i, todo) { // the first is already on its way
    var id = todo.attr('id');
    if (id && !todo[0].deleted) fetch(url + '/' + id + '/move' + placement(todo), { method: 'POST', headers: headers, keepalive: true }).catch(function() {});
  });
  moves.length = Math.min(moves.length, 1);
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
