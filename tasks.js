var API = 'https://tasks.googleapis.com/tasks/v1/';
var tasksLoaded = false;
var session = 0; // goes up on log out or changing list, so late answers are ignored

function checkAuth() {
  if (loggedOut()) return showLogIn();
  if (auth.hint) auth.hint(currentAccount()); // so renewing asks for the same one
  auth.silent(handleAuthResult);
}

function handleAuthResult(ok) {
  if (!ok) return showLogIn();
  if (tasksLoaded) return saveAll(); // logged in again: save what couldn't be saved
  showStatus('Loading\u2026');
  start();
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

var lastReason = ''; // why Google last refused something
var retryWait = 1000;

// Is Google only asking us to wait? A new task isn't sent again after a server
// fault, as it may have been made.
function shouldRetry(method, answer) {
  if (answer.status === 429) return true;
  if (answer.status === 403) return /rate|quota|limit/i.test(answer.reason);
  return answer.status >= 500 && method !== 'POST';
}

// Calls Google. done(result) on success, failed(status) if not; status is undefined
// when Google couldn't be reached. A refused token is replaced and tried once more,
// and it waits its turn when there have been too many requests.
function send(method, path, body, done, failed, again, tries) {
  var started = session;
  if (/^(users\/@me\/)?lists\/drive%3A/.test(path)) { // a shared list, kept in Drive
    return shared.request(method, path, body, function(result) {
      if (started === session && done) done(result);
    }, function(status) {
      if (started === session && failed) failed(status);
    });
  }
  var options = { method: method, headers: { 'Authorization': 'Bearer ' + auth.token() } };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  fetch(API + path, options).then(function(response) {
    return response.text().then(function(text) {
      var answer = { ok: response.ok, status: response.status };
      var data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        if (response.ok) throw e;
      }
      if (response.ok) answer.result = data;
      else {
        var error = (data && data.error) || {};
        answer.reason = [error.errors && error.errors[0] && error.errors[0].reason, error.message].filter(Boolean).join(': ');
      }
      return answer;
    });
  }).catch(function(error) {
    return { ok: false, reason: String(error) };
  }).then(function(answer) {
    if (started !== session) return;
    if (answer.ok) {
      if (done) done(answer.result);
      return;
    }
    if (answer.status === 401 && !again) {
      auth.expired(function(ok) {
        if (started !== session) return;
        if (ok) send(method, path, body, done, failed, true, tries);
        else if (failed) failed(401);
      });
      return;
    }
    tries = tries || 0;
    if (tries < 5 && shouldRetry(method, answer)) {
      setTimeout(function() {
        if (started === session) send(method, path, body, done, failed, again, tries + 1);
      }, retryWait * Math.pow(2, tries) * (1 + Math.random() / 2));
      return;
    }
    lastReason = answer.reason || '';
    console.info('Google: ' + method + ' ' + (answer.status || '') + ' ' + lastReason);
    if (failed) failed(answer.status);
  });
}

// Calls Google about a task, in its own list.
function api(todo, method, path, body, done, failed) {
  send(method, 'lists/' + encodeURIComponent(todo[0].card[0].list) + '/tasks' + path, body, done, failed);
}

// Google's access runs out after about an hour, which shows up as a 401.
function showFailure(text, status, retry) {
  if (status === 401) return showMessage(text + ' Please log in again.', 'Log in', handleAuthClick);
  if (!status) text += ' Check your connection.';
  else if (lastReason) text += ' Google said: ' + lastReason.replace(/^\w+: /, '');
  showMessage(text, retry && 'Retry', retry, retry ? 0 : 6000);
}

// ---- Lists. Each one on screen is a card, whose element holds:
//   list  its id       loaded  whether its tasks are shown
//   doneShown, doneWaiting  see Completed tasks

var lists = [];
var defaultList; // the id of the one that Google won't delete

// The ids of the lists you've chosen not to show. Pass them to set them.
var hiddenHere = [];

function hiddenLists(ids) {
  var key = 'tabandtick-hidden' + (currentAccount() ? ':' + currentAccount() : '');
  try {
    if (ids) localStorage.setItem(key, JSON.stringify(ids));
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch (e) { // storage is blocked, or not ours
    if (ids) hiddenHere = ids;
    return hiddenHere;
  }
}

function isHidden(id) {
  return $.inArray(id, hiddenLists()) >= 0;
}

function start() {
  send('GET', 'users/@me/lists?maxResults=100', null, function(result) {
    if (tasksLoaded) return; // a late silent sign-in must not show them twice
    tasksLoaded = true;
    lists = (result && result.items) || [];
    showStatus('');
    $('body').addClass('signed-in').toggleClass('can-share', !!auth.canShare).toggleClass('can-switch', !!auth.canSwitch);
    showAccounts();
    showLists();
    loadProfile();
    startShared();
    send('GET', 'users/@me/lists/@default', null, function(list) { defaultList = list.id; });
  }, function(status) {
    showLogIn();
    showMessage('Logged in, but your lists couldn’t be loaded (' + (status || 'no connection') + ').', 'Retry', checkAuth);
  });
}

// Your shared lists go after your Google Tasks ones.
function withShared(googleLists) {
  return $.grep(googleLists, function(list) { return !list.shared; }).concat(shared.lists());
}

function startShared() {
  var started = session;
  shared.start(function() {
    if (started !== session) return;
    lists = withShared(lists);
    showLists();
    openLink();
  });
}

function findList(id) {
  return $.grep(lists, function(list) { return list.id === id; })[0];
}

function cardFor(id) {
  return $('#cards .card').filter(function() { return this.list === id; });
}

// The sidebar, and a card for each list that isn't hidden.
function showLists() {
  $('#lists').empty().append($.map(lists, function(list) {
    return $('<li></li>').append($('<label></label>').append(
      $('<input type="checkbox"/>').prop('checked', !isHidden(list.id)).attr('data-list', list.id),
      $('<span class="name"></span>').text(list.title),
      list.shared ? $(PEOPLE).attr('aria-label', 'Shared').attr('role', 'img') : null,
      $('<span class="count"></span>').text(list.count === undefined ? '' : list.count)
    ));
  }));
  var hidden = $.grep(lists, function(list) { return isHidden(list.id); }).length;
  $('#none-shown').toggle(tasksLoaded && lists.length > 0 && hidden === lists.length);
  $('#cards .card').each(function() {
    if (!findList(this.list) || isHidden(this.list)) $(this).remove();
  });
  $.each(lists, function(i, list) {
    if (isHidden(list.id)) return countHidden(list);
    var card = cardFor(list.id), made = !card.length;
    if (made) card = newCard(list);
    if (made || !card.is($('#cards').children().eq(i))) $('#cards').append(card);
    if (!card.find('.list-title').is(':focus')) card.find('.list-title').val(list.title);
    card.find('.claire').attr('aria-label', list.title);
    card.toggleClass('shared', !!list.shared);
    card.find('[data-list-do=delete]').text(list.shared && !list.owned ? 'Leave list' : 'Delete list');
    if (made && list.shared) showSharers(card);
    card.find('.done-list').attr('aria-label', 'Completed in ' + list.title);
    if (made) loadCard(card);
  });
  showTabs();
  refreshRows();
}

// ---- On a phone: a tab for each list shown, and only the chosen list's card, as in
// Google's Tasks app. The tabs are always made; the stylesheet shows them on phones.

function chosenTab(id) {
  try {
    if (id) localStorage.setItem('tabandtick-tab', id);
    return localStorage.getItem('tabandtick-tab');
  } catch (e) { return id || null; }
}

function showTabs() {
  var cards = $('#cards .card'), want = chosenTab();
  if (!cards.filter(function() { return this.list === want; }).length) want = cards.length ? cards[0].list : null;
  cards.each(function() { $(this).toggleClass('current', this.list === want); });
  $('#list-tabs').empty().append(cards.map(function() {
    var list = findList(this.list) || {}, on = this.list === want;
    return $('<button type="button" role="tab" class="tab"></button>').attr({ 'data-list': this.list, 'aria-selected': String(on) })
      .toggleClass('on', on).append($('<span class="label"></span>').text(list.title || ''), list.shared ? $(PEOPLE).attr('aria-hidden', 'true') : null)[0];
  }).get(), $('<button type="button" class="tab new-list-tab"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>New list</button>'));
  var on = $('#list-tabs .tab.on')[0];
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function chooseTab(id) {
  chosenTab(id);
  showTabs();
  refreshRows();
}

function newCard(list) {
  var card = $('#card-template').children().clone();
  card[0].list = list.id;
  card[0].loaded = false;
  card[0].doneShown = 0;
  card[0].doneWaiting = [];
  return card;
}

function loadCard(card) {
  var list = card[0].list;
  card.find('.note').show().text('Loading…');
  fetchAll(list, 'showCompleted=false', function(tasks) {
    if (card[0].loaded || !$.contains(document, card[0])) return;
    card[0].loaded = true;
    card.find('.note').hide();
    showTasks(card, tasks);
    loadTicked(card);
    countDone(card);
  }, function(status) {
    if (status === 404) { // deleted elsewhere
      lists = $.grep(lists, function(other) { return other.id !== list; });
      return showLists();
    }
    card.find('.note').text('Couldn’t load this list (' + (status || 'no connection') + '). ')
      .append($('<button type="button">Retry</button>').click(function() { loadCard(card); }));
  });
}

function countHidden(list) {
  if (list.count !== undefined) return;
  list.count = ''; // asked for
  fetchAll(list.id, 'showCompleted=false', function(tasks) {
    list.count = tasks.length;
    showCount(list);
  });
}

function showCount(list) {
  $('#lists input').filter(function() { return $(this).attr('data-list') === list.id; }).siblings('.count').text(list.count);
}

// Wait for everything to be saved, then go on.
function settle(anyway, done) {
  saveAll();
  var tries = 0;
  (function wait() {
    if (!anyUnsaved()) return done();
    if (tries++ < 20) return setTimeout(wait, 250);
    showMessage('Some changes couldn’t be saved.', anyway, done);
  })();
}

function anyUnsaved() {
  return shared.unsaved() || moves.length > 0 || ticking > 0 || $('.todo').filter(function() { return this.saving || isUnsaved($(this)); }).length > 0;
}

function finishRemovals() {
  while (removals.length) finishRemoval(removals[0]);
}

function showList(id, show) {
  if (show) {
    hiddenLists($.grep(hiddenLists(), function(other) { return other !== id; }));
    return showLists();
  }
  settle('Hide anyway', function() {
    finishRemovals();
    hiddenLists(hiddenLists().concat(id));
    showLists();
  });
}


function createList(title) {
  send('POST', 'users/@me/lists', { title: title }, function(list) {
    lists.push(list);
    chosenTab(list.id); // its tab, on a phone
    showLists();
    newTask(cardFor(list.id));
  }, function(status) {
    showFailure('Could not create that list.', status);
  });
}

function renameList(card, title) {
  var list = findList(card[0].list), field = card.find('.list-title');
  if (!list) return;
  if (!title || title === list.title) return field.val(list.title);
  send('PATCH', 'users/@me/lists/' + encodeURIComponent(list.id), { title: title }, function() {
    list.title = title;
    showLists();
  }, function(status) {
    field.val(list.title);
    showFailure('Could not rename that list.', status);
  });
}

// Ask, saying what is in it. Deleting a list would also delete the originals of
// any tasks in it assigned from Docs or Chat, so don't.
function deleteList(id) {
  var list = findList(id);
  if (list && list.shared) return settle('Go on anyway', function() { finishRemovals(); shared.remove(id); });
  if (id === defaultList) return showMessage('Google doesn’t let your first list be deleted.', null, null, 5000);
  settle('Go on anyway', function() {
    finishRemovals();
    fetchAll(id, 'showCompleted=true&showHidden=true&showAssigned=true', function(tasks) {
      if (tasks.some(function(task) { return task.assignmentInfo; })) {
        return showMessage('That list has tasks assigned from Docs or Chat, so delete it in Google Tasks instead.', null, null, 8000);
      }
      var done = $.grep(tasks, function(task) { return task.status === 'completed'; }).length;
      if (tasks.length - done < cardFor(id).find('.claire .todo[id]').not('.checked').length) {
        return showMessage('That list has changed, so it hasn\u2019t been deleted. Refresh and try again.', null, null, 8000);
      }
      ask({
        title: 'Delete “' + list.title + '”?',
        text: tasks.length ? 'It has ' + (tasks.length - done) + ' open and ' + done + ' completed tasks. They’ll be deleted from Google Tasks too, and this can’t be undone.' : 'It has no tasks. This can’t be undone.',
        button: 'Delete', danger: true
      }, function() {
        send('DELETE', 'users/@me/lists/' + encodeURIComponent(id), null, function() {
          lists = $.grep(lists, function(other) { return other.id !== id; });
          showLists();
          showMessage('List deleted.', null, null, 4000);
        }, function(status) {
          showFailure('Could not delete that list.', status);
        });
      });
    }, function(status) {
      showFailure('Could not check that list, so it hasn’t been deleted.', status);
    });
  });
}

// ---- Sharing. Google Tasks can't share lists, so shared ones are kept in Google
// Drive: see shared.js.

var PEOPLE = '<svg class="shared-icon" width="18" height="18" viewBox="0 0 20 20"><circle cx="7.5" cy="7" r="3" fill="currentColor"/><path d="M1.5 16.5c.6-3 3-4.6 6-4.6s5.4 1.6 6 4.6z" fill="currentColor"/><circle cx="14" cy="7.5" r="2.4" fill="currentColor" opacity=".7"/><path d="M14.6 11.4c2 .3 3.5 1.8 3.9 4.1h-3.3c-.3-1.6-1-3-2.2-3.9.5-.1 1-.2 1.6-.2z" fill="currentColor" opacity=".7"/></svg>';

// Drive's permission is asked for only when you first share, as it isn't needed
// before. Google's window needs a click, which this is called from.
function withDrive(then) {
  if (auth.hasDrive()) return then();
  auth.drive(function(ok, reason) {
    if (!ok) return showMessage('Shared lists need Google Drive' + (reason ? ' (' + reason + ').' : '.'), null, null, 8000);
    startShared();
    then();
  });
}

function askSharedList() {
  withDrive(function() {
    ask({ title: 'New shared list', text: 'Share it with anyone with a Google account. It’s kept in your Google Drive.', field: '', placeholder: 'List name', button: 'Create' }, function(title) {
      shared.create(title, [], function(list) {
        addShared(list);
        shareList(list.id);
      }, function(status) {
        showFailure('Could not create that list.', status);
      });
    });
  });
}

function addShared(list) {
  if (!findList(list.id)) lists.push(list);
  hiddenLists($.grep(hiddenLists(), function(other) { return other !== list.id; }));
  chosenTab(list.id); // its tab, on a phone
  showLists();
}

// A Google Tasks list can't be shared, so offer a shared copy of it.
function offerCopy(id) {
  var list = findList(id);
  if (!list) return;
  ask({
    title: 'Share “' + list.title + '”?',
    text: 'Google Tasks can’t share lists, so this makes a shared copy of it, with its open tasks, in your Google Drive. The original stays in Google Tasks.',
    button: 'Make a shared copy'
  }, function() {
    withDrive(function() {
      showMessage('Copying…');
      shared.copy(list, function(copy) {
        hideMessage();
        addShared(copy);
        shareList(copy.id);
      }, function(status) {
        showFailure('Could not copy that list.', status);
      });
    });
  });
}

// Who has the list, a field to add someone, and its link.
function shareList(id) {
  var list = findList(id), dialog = $('#share'), field = dialog.find('input[type=email]'), people = dialog.find('.people');
  if (!list) return;
  if (!list.shared) return offerCopy(id);
  closeMenu();
  dialog.find('h2').text('Share “' + list.title + '”');
  field.val('').prop('disabled', list.canShare === false);
  dialog.find('.share-add button').prop('disabled', true);
  function showPeople() {
    people.empty().append($('<li class="loading"></li>').text('Loading…'));
    shared.people(id, function(all) {
      people.empty().append($.map(all, function(p) {
        var row = $('<li></li>').append(face(p, 36), $('<span class="who"></span>').append(
          $('<span class="name"></span>').text(p.name || p.email),
          p.name && p.email ? $('<span class="email"></span>').text(p.email) : null));
        if (p.role === 'owner') row.append($('<span class="role"></span>').text('Owner'));
        else if (list.owned && p.type === 'user') row.append($('<button type="button" class="unshare"></button>').attr('aria-label', 'Stop sharing with ' + (p.name || p.email)).html('&times;').click(function() {
          shared.uninvite(id, p.id, showPeople, function(status) { showFailure('Could not stop sharing with them.', status); });
        }));
        return row[0];
      }));
      showSharers(cardFor(id), all);
    }, function() {
      people.empty();
    });
  }
  field.off('input').on('input', function() {
    dialog.find('.share-add button').prop('disabled', !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($.trim(field.val())));
  });
  dialog.find('form').off('submit').on('submit', function(event) {
    event.preventDefault();
    var email = $.trim(field.val());
    if (!email) return;
    dialog.find('.share-add button').prop('disabled', true);
    shared.invite(id, email, function() {
      field.val('');
      showPeople();
      announce('Shared with ' + email + '.');
    }, function(status) {
      dialog.find('.share-add button').prop('disabled', false);
      if (status === 400) showMessage('Could not share with ' + email + '. Check it’s a Google account.', null, null, 8000);
      else showFailure('Could not share that list.', status);
    });
  });
  dialog.find('.copy-link').off('click').on('click', function() {
    var button = $(this);
    navigator.clipboard.writeText(shared.link(id)).then(function() {
      button.text('Link copied');
      setTimeout(function() { button.text('Copy link'); }, 2000);
    }, function() {
      showMessage(shared.link(id), null, null, 15000);
    });
  });
  dialog.find('.close').off('click').on('click', function() { dialog[0].close(); });
  showPeople();
  dialog[0].showModal();
  if (!field.prop('disabled')) field.focus();
}

// A person's Google picture, or their initial if there's none or it won't load.
function face(person, size) {
  var initial = $('<span class="face" aria-hidden="true"></span>').text((person.name || person.email || '?').charAt(0).toUpperCase())
    .css({ width: size, height: size, fontSize: Math.round(size * 0.45) });
  if (!person.photo) return initial;
  var img = $('<img class="face" alt="" referrerpolicy="no-referrer">').attr({ src: person.photo, width: size, height: size });
  img.on('error', function() { img.replaceWith(initial); });
  return img;
}

// The faces of who else has a shared list, by its Share button, as in Google Docs.
// Pass who if already known.
function showSharers(card, who) {
  if (!card.length || !card.hasClass('shared')) return;
  if (!who) return shared.people(card[0].list, function(all) { showSharers(card, all); }, function() {});
  var me = currentAccount(), others = $.grep(who, function(p) { return p.type === 'user' && p.email !== me; });
  var shown = others.slice(0, 3), more = others.length - shown.length;
  var names = $.map(others, function(p) { return p.name || p.email; });
  card.find('.sharers').empty().attr('title', names.length ? 'Shared with ' + names.join(', ') : null)
    .attr('aria-label', names.length ? 'Shared with ' + names.join(', ') : null)
    .append($.map(shown, function(p) { return face(p, 28)[0]; }))
    .append(more > 0 ? $('<span class="face more-people" aria-hidden="true"></span>').text('+' + more) : null);
}

// A link to a shared list: tabandtick.github.io/app/#open=<its file>. Kept until
// you're logged in, then opened.
// #pick, from the extension, which can't show Google's file picker itself, opens that.
var linkToOpen = (function() {
  var m = location.hash.match(/^#(?:open=([\w-]+)|(pick))$/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return m[1] || 'pick';
})();

function openLink() {
  var id = linkToOpen;
  if (!id || !tasksLoaded) return;
  linkToOpen = null;
  if (!auth.canShare) return showMessage('Shared lists open on the website: tabandtick.github.io/app', null, null, 10000);
  if (id === 'pick') {
    return ask({ title: 'Open a list shared with you?', text: 'Google asks you to pick it once, to let Tab & Tick open it. It then opens in the extension too.', button: 'Choose' }, pickShared);
  }
  var known = findList('drive:' + id);
  if (known) return showOpened(known);
  ask({ title: 'Open a shared list?', text: 'Someone shared a list with you. To open it, Tab & Tick asks Google for the files you open with it in Google Drive.', button: 'Open it' }, function() {
    withDrive(function() { openShared(id); });
  });
}

function openShared(id) {
  shared.open(id, function(list) {
    addShared(list);
    showOpened(list);
  }, function(status) {
    if (status !== 404 && status !== 403) return showFailure('Could not open that list.', status);
    // Drive lets an app open a file shared with you once you've picked it
    shared.pick(id, function(picked) {
      shared.open(picked, function(list) {
        addShared(list);
        showOpened(list);
      }, function(status) { showFailure('Could not open that list.', status); });
    });
  });
}

function pickShared() {
  withDrive(function() {
    shared.pick(null, openShared);
  });
}

function showOpened(list) {
  var card = cardFor(list.id);
  if (card.length) card[0].scrollIntoView({ block: 'nearest' });
  showMessage('Opened “' + list.title + '”.', null, null, 4000);
}

// Back to the tab after a while: show what changed in other tabs or on other
// devices. Lists that are being edited or saved are left until next time.
function refreshAll() {
  if (!tasksLoaded || !signedIn()) return;
  var started = session;
  send('GET', 'users/@me/lists?maxResults=100', null, function(result) {
    if (started !== session) return;
    var fresh = withShared((result && result.items) || []);
    var same = fresh.length === lists.length && fresh.every(function(list, i) { return list.id === lists[i].id && list.title === lists[i].title; });
    if (!same) {
      lists = fresh;
      showLists();
    }
  });
  $('#cards .card').each(function() {
    if (this.loaded) reload($(this));
    if ($(this).hasClass('shared')) showSharers($(this));
  });
  shared.check();
  startShared(); // any opened elsewhere since, such as on the website from the extension
}

// Tick tasks, or untick them, as one: one message, and one undo.
function tickAll(todos, done) {
  todos = todos.filter(function() { return this.id || this.value; }); // not a blank new row
  if (!todos.length) return;
  todos.each(function() {
    var box = $(this).siblings('input[type=checkbox]');
    if (box.prop('checked') === done) return;
    box.prop('checked', done);
    setCompleted(box, null, true);
  });
  var list = todos.get();
  function can() { return list.some(function(el) { return live($(el)).hasClass('checked') === done; }); }
  function undo() { tickAll($($.map(list, function(el) { return live($(el)).get(); })), !done); }
  canUndo(can, undo);
  if (removals.length) return; // keep the button for a delete
  showMessage((list.length > 1 ? list.length + ' tasks ' : 'Task ') + (done ? 'completed.' : 'marked uncompleted.'), 'Undo', function() { if (can()) undo(); }, 7000);
}

function logOut() {
  settle('Log out anyway', endSession);
}

// Forget everything on screen, as for logging out or switching account.
function resetSession() {
  undoStack = [];
  ticking = 0;
  flush(); // finishes any deletes
  session++;
  moves = [];
  shared.reset();
  tasksLoaded = false;
  selected = $();
  picked = null;
  lists = [];
  defaultList = undefined;
  hideMessage();
  closeMenu();
  $('#cards, #lists').empty();
  $('#none-shown').hide();
  $('body').removeClass('signed-in side-open');
  showProfile(null);
}

// Log out of this account. If you've added others, it goes to the next of them.
function endSession() {
  var email = currentAccount(), others = $.grep(accounts(), function(a) { return a.email !== email; });
  resetSession();
  auth.logout();
  if (auth.forget && email) auth.forget(email);
  accounts(others);
  currentAccount('');
  if (others.length && auth.canSwitch) return useAccount(others[0].email);
  loggedOut(true);
  showLogIn();
}

// ---- More than one Google account. Those you've added are kept in this browser, with
// the one in use; each has its own sign-in, kept as on a single account.

function stored(key, value) {
  try {
    if (value !== undefined) localStorage.setItem(key, JSON.stringify(value));
    return JSON.parse(localStorage.getItem(key));
  } catch (e) { // storage is blocked, or not ours
    return value;
  }
}

// [{ email, name, picture }]. Pass them to set them.
function accounts(list) {
  return stored('tabandtick-accounts', list) || [];
}

// The email of the one in use, or ''. Pass it to set it.
function currentAccount(email) {
  return stored('tabandtick-account', email) || '';
}

// Show the other one. Its own sign-in is used if it's fresh; if not, Google's window
// opens, which needs the click this is called from, so nothing is waited for first
// unless something is still being saved.
function switchAccount(email) {
  closeMenu();
  if (email === currentAccount()) return;
  settle('Switch anyway', function() {
    finishRemovals();
    resetSession();
    useAccount(email);
  });
}

function useAccount(email) {
  currentAccount(email);
  showStatus('Loading…');
  auth.use(email, function(ok, reason) {
    if (ok) return start();
    showLogIn();
    showMessage('Couldn’t switch to ' + email + (reason ? ' (' + reason + ').' : '.') + ' Log in to use it.', null, null, 10000);
  });
}

function addAccount() {
  closeMenu();
  var was = currentAccount();
  settle('Go on anyway', function() {
    finishRemovals();
    resetSession();
    currentAccount('');
    showStatus('Loading…');
    auth.add(function(ok) {
      if (ok) return start();
      if (was) return useAccount(was); // you closed Google's window: back to the one you had
      showLogIn();
    });
  });
}

// Your accounts, in the account menu: the one in use at the top, the others under it.
function showAccounts() {
  var email = currentAccount();
  $('#other-accounts').empty().append($.map(accounts(), function(a) {
    if (a.email === email) return null;
    var face = a.picture ? $('<img class="face" alt="" width="28" height="28" referrerpolicy="no-referrer">').attr('src', a.picture)
      : $('<span class="face" aria-hidden="true"></span>').text((a.name || a.email).charAt(0).toUpperCase());
    return $('<button type="button" role="menuitem" class="other-account"></button>').attr('data-email', a.email).append(
      face, $('<span class="who"></span>').append($('<span class="name"></span>').text(a.name || a.email), a.name ? $('<span class="email"></span>').text(a.email) : null)
    )[0];
  }));
}

// Your name, email and picture, for the account button. Nothing else uses them,
// and if Google won't give them, the button just has no picture.
function loadProfile() {
  var started = session, token = auth.token();
  if (!token) return showProfile(null);
  fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(response) { return response.ok ? response.json() : null; })
    .catch(function() { return null; })
    .then(function(profile) {
      if (started !== session) return;
      showProfile(profile);
      if (!profile || !profile.email) return;
      if (auth.hint) auth.hint(profile.email);
      if (auth.remember) auth.remember(profile.email);
      var was = currentAccount();
      var all = accounts();
      var at = all.map(function(a) { return a.email; }).indexOf(profile.email);
      var me = { email: profile.email, name: profile.name || '', picture: profile.picture || '' };
      if (at >= 0) all[at] = me; else all.push(me);
      accounts(all);
      currentAccount(profile.email);
      showAccounts();
      if (was !== profile.email) showLists(); // its own hidden lists
    });
}

function showProfile(profile) {
  profile = profile || {};
  var name = profile.name || '', email = profile.email || '';
  var avatar = $('#avatar');
  avatar.off('error').on('error', function() { avatar.prop('hidden', true); }); // shows the initial instead
  avatar.prop('hidden', !profile.picture).attr('src', profile.picture || null);
  $('#initial').text((name || email).charAt(0).toUpperCase());
  $('#account-name').text(name).toggle(!!name);
  $('#account-email').text(email).toggle(!!email);
  $('#account').toggleClass('has-profile', !!(name || email));
  $('#account-button').attr('aria-label', email ? 'Account: ' + email : 'Account').attr('title', email || null);
}

// ---- Tasks

// Google returns at most 100 tasks at a time.
function fetchAll(list, query, done, failed, tasks, pageToken) {
  var path = 'lists/' + encodeURIComponent(list) + '/tasks?maxResults=100&' + query;
  send('GET', path + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), null, function(result) {
    var all = (tasks || []).concat((result && result.items) || []);
    if (result && result.nextPageToken) return fetchAll(list, query, done, failed, all, result.nextPageToken);
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

function rows(card, tasks) {
  return $.map(tasks, function(task) { return taskRow(task, card); });
}

function showTasks(card, tasks) {
  var open = card.find('.claire'), active = document.activeElement;
  var ticked = open.children().filter(function() { return $(this).children('.todo').hasClass('checked'); }).detach();
  var unmade = open.children().filter(function() { return !$(this).children('.todo').attr('id'); }).detach(); // added while loading
  var focused = unmade.find('.todo').filter(function() { return this === active; });
  open.empty().append(unmade, rows(card, inOrder(tasks)));
  focused.focus();
  open.find('.todo').each(function() { // not indented if its parent isn't here
    if (this.parentTask && !document.getElementById(this.parentTask)) $(this).parent().removeClass('subtask');
  });
  ticked.each(function() {
    var todo = $(this).children('.todo');
    if (!document.getElementById(todo.attr('id')) && openParent(todo).length) placeSubtask(todo);
  });
  card.find('.done').show();
  refreshRows();
}

// The open task that this one is a subtask of, if it is on screen.
function openParent(todo) {
  var id = todo[0].parentTask;
  return todo[0].card.find('.claire .todo').not('.checked').filter(function() { return id && this.id === id; });
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
function placeTicked(card, tasks) {
  var rest = $.grep(tasks, function(task) {
    if (task.status !== 'completed' || document.getElementById(task.id) || isRemoved(task.id)) return false;
    if (!task.parent) return true;
    var row = taskRow(task, card), todo = row.children('.todo');
    if (!openParent(todo).length) return true;
    placeSubtask(todo);
    return false;
  });
  refreshRows();
  return rest;
}

// Google can't be asked for these alone, so look at what has changed in a year.
function loadTicked(card) {
  if (!card.find('.claire li').length) return;
  fetchAll(card[0].list, 'showCompleted=true&showHidden=true&updatedMin=' + encodeURIComponent(new Date(Date.now() - 365 * 864e5).toISOString()), function(tasks) {
    if ($.contains(document, card[0])) placeTicked(card, tasks);
  });
}

function refreshRows() {
  if (searchWords().length) applySearch(); // rows made or moved since
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

// Show the list as Google now has it, unless that would lose something. Says
// whether it went ahead.
function reload(card) {
  if (!signedIn() || busy() || !card[0].loaded) return false;
  fetchAll(card[0].list, 'showCompleted=false', function(tasks) {
    if (busy() || !$.contains(document, card[0])) return;
    var active = $(document.activeElement), open = card.find('.claire');
    var id = active.closest(open.children()).children('.todo').attr('id');
    var field = active.is('.notes') ? '.notes' : '.todo';
    var start = active[0] && active[0].selectionStart;
    showTasks(card, tasks);
    open.find('.todo').each(function() {
      var row = $(this).parent();
      if (id && this.id === id) row.find(field).setCursorPosition(start || 0);
    });
    loadTicked(card);
    countDone(card);
  });
  return true;
}

function busy() {
  return removals.length > 0 || moves.length > 0 || ticking > 0 || $('li.leaving').length > 0 || $('.claire .todo').filter(function() {
    return !this.id || this.saving || isUnsaved($(this));
  }).length > 0;
}

// ---- Completed tasks, loaded only when asked for, newest first, ten at a time

var doneDays = [30, 365, 0]; // how far back each request goes; 0 is everything
// On the card: doneShown is how many of those have been made, and doneWaiting is
// what has been loaded but not shown yet.

function toggleDone(card) {
  var open = !card.find('.done').hasClass('open');
  card.find('.done').toggleClass('open', open);
  card.find('.done-toggle').attr('aria-expanded', String(open));
  if (open && !card[0].doneShown) loadDone(card);
  refreshRows();
  loadMoreIfNear();
}

function loadDone(card) {
  var el = card[0], more = card.find('.done-more');
  if (el.doneWaiting.length >= 10 || el.doneShown === doneDays.length) return showDone(card);
  var days = doneDays[el.doneShown];
  more.prop('disabled', true).text('Loading\u2026').show();
  // Not completedMin: subtasks completed along with their parent may have no date.
  var since = days ? '&updatedMin=' + encodeURIComponent(new Date(Date.now() - days * 864e5).toISOString()) : '';
  fetchAll(el.list, 'showCompleted=true&showHidden=true' + since, function(tasks) {
    el.doneShown++;
    el.doneWaiting = inDoneOrder(placeTicked(card, tasks));
    loadDone(card);
  }, function(status) {
    more.prop('disabled', false).text('Try again').show();
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

function showDone(card) {
  var el = card[0], waiting = el.doneWaiting, next = waiting.splice(0, 10);
  while (next.length && waiting.length && waiting[0].parent && next.some(function(task) { return task.id === waiting[0].parent; })) {
    next.push(waiting.shift()); // don't split a family
  }
  card.find('.done-list').append(rows(card, $.grep(next, function(task) { return !document.getElementById(task.id); })));
  var more = waiting.length > 0 || el.doneShown < doneDays.length;
  card.find('.done-more').prop('disabled', false).text('Load more').toggle(more);
  sortDone(card);
  card.find('.done-none').toggle(!card.find('.done-list li').length);
  setTimeout(loadMoreIfNear, 0);
}

// Load more when the end of a list is near the bottom of the window.
var autoDone = true;

function loadMoreIfNear() {
  if (!autoDone) return;
  $('#cards .card').each(function() {
    var card = $(this), more = card.find('.done-more');
    if (!card.find('.done').hasClass('open') || !this.doneShown || !more.is(':visible')) return;
    if (more.prop('disabled') || more.text() === 'Try again') return;
    if (more[0].getBoundingClientRect().top < window.innerHeight + 300) loadDone(card);
  });
}

// "Completed (3)", or nothing at all when there are none, as in Google Tasks. The
// total is counted by countDone, or known once everything has been loaded.
function updateDoneCount() {
  $('#cards .card').each(function() {
    var loaded = $(this).find('.done-list li').length + this.doneWaiting.length;
    var total = this.doneShown === doneDays.length ? loaded : this.doneTotal;
    $(this).find('.done-toggle').text('Completed' + (typeof total === 'number' ? ' (' + total + ')' : ''));
    $(this).find('.done').toggle(this.loaded && (total > 0 || loaded > 0));
  });
}

// Ask Google how many completed tasks a list has: their ids only, a page at a time.
// Not completedMin, as subtasks completed with their parent may have no date.
function countDone(card) {
  var el = card && card[0];
  if (!el) return;
  clearTimeout(el.countTimer);
  var started = session;
  el.countTimer = setTimeout(function() {
    if (started !== session) return; // logged out, or another account, since
    var count = 0;
    (function page(token) {
      send('GET', 'lists/' + encodeURIComponent(el.list) + '/tasks?showCompleted=true&showHidden=true&maxResults=100&fields=items(id,status),nextPageToken' +
        (token ? '&pageToken=' + encodeURIComponent(token) : ''), null, function(result) {
        count += $.grep((result && result.items) || [], function(task) { return task.status === 'completed' && !isRemoved(task.id); }).length;
        if (result && result.nextPageToken) return page(result.nextPageToken);
        el.doneTotal = count;
        updateDoneCount();
      });
    })();
  }, 500); // once a burst of changes has settled
}

function sortDone(card) {
  var list = card.find('.done-list'), all = list.children(), ids = {}, top = [];
  function el(row) { return $(row).children('.todo')[0]; }
  all.each(function() { ids[el(this).id] = true; });
  all.each(function() {
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
    list.append(row, id ? all.filter('.subtask').filter(function() { return el(this).parentTask === id; }) : null);
  });
  if (all.length) card.find('.done-none').hide();
  refreshRows();
}

// Tick or untick. The row moves between the lists once Google agrees, except that
// a ticked subtask stays with its open parent.
var ticking = 0; // ticks Google hasn't answered yet

// As in Google Tasks (measured there): a ticked task stays a moment, ticked but not
// struck through. Then the tasks below slide up over it, 150ms with ease, and it goes
// to Completed. It doesn't shrink or fade: it's covered. Tests set these to 0.
var tickPause = 400, closeTime = 150, openTime = 300, reopenDelay = 100;

// Moves like Google Tasks' own (measured there): the rows glide by transform, which the
// graphics card does without laying the page out again each frame, and only the list's
// height animates with them. "rows" start offset by "from" pixels and glide to where
// they are; the list goes from "fromHeight" to its own height. done() when finished.
function glide(list, rows, from, fromHeight, ms, done) {
  var toHeight = list.offsetHeight;
  rows.addClass('covering').css({ transition: 'none', transform: 'translateY(' + from + 'px)' });
  $(list).css({ transition: 'none', height: fromHeight + 'px', overflow: 'visible' });
  list.offsetHeight; // so the changes below are animated
  rows.css({ transition: 'transform ' + ms + 'ms ease', transform: '' });
  $(list).css({ transition: 'height ' + ms + 'ms ease', height: toHeight + 'px' });
  return setTimeout(function() {
    rows.removeClass('covering').css({ transition: '', transform: '' });
    $(list).css({ transition: '', height: '', overflow: '' });
    if (done) done();
  }, ms);
}

function still() {
  return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Unticked, as in Google Tasks: it's put back under the tasks already there, which
// glide down off it over 300ms with ease, as the list grows.
function slideOpen(block, done) {
  if (still() || !openTime || !block.length || !block[0].offsetParent) return done && done();
  var list = block.parent()[0];
  var height = block.get().reduce(function(sum, el) { return sum + el.getBoundingClientRect().height; }, 0);
  block.addClass('covered');
  glide(list, block.last().nextAll(), -height, list.offsetHeight - height, openTime, function() {
    block.removeClass('covered');
    if (done) done();
  });
}

// The ripple from the tick, and, when ticking, sparks bursting out of it: Google Tasks'
// "checkmark pop", drawn our own way. Purple where Google has blue.
var SPARKS = ['var(--accent)', '#ef6f6c', '#ef6f6c', '#f4b740', '#3fbf8f', '#ef6f6c', '#f4b740', '#ef6f6c'];
function pop(checkbox, sparks) {
  var row = checkbox.parent(), box = checkbox[0];
  if (!box.offsetParent) return;
  var burst = $('<span class="pop" aria-hidden="true"><span class="ripple"></span></span>').css({
    left: box.offsetLeft + box.offsetWidth / 2, top: box.offsetTop + box.offsetHeight / 2
  });
  if (sparks) $.each(SPARKS, function(i, colour) {
    burst.append($('<span class="spark"></span>').css({ background: colour, '--a': (i * 45) + 'deg' }));
  });
  row.append(burst);
  setTimeout(function() { burst.remove(); }, 500);
}

// Ticked: from the moment it's ticked, not when Google replies, as Google Tasks doesn't
// wait either. After the pause the rows below slide up over it, and it stays covered
// until Google has said yes too: then it goes to Completed (see landed).
function startLeaving(row, checkbox) {
  var el = row[0];
  if (still() || !closeTime) return;
  clearTimeout(el.leaveTimer);
  el.leaveTimer = setTimeout(function() {
    if (!checkbox.prop('checked') || !$.contains(document, el) || !row.hasClass('leaving')) return;
    var list = row.parent()[0], oldHeight = list.offsetHeight;
    var block = row.add(row.hasClass('subtask') ? $() : subtaskRows(row.children('.todo')));
    var height = block.get().reduce(function(sum, b) { return sum + b.getBoundingClientRect().height; }, 0);
    // Out of the list's flow, where it is, under the rows that will cover it
    $(list).css('position', 'relative'); // first, so offsetTop is within the list
    var tops = block.map(function() { return this.offsetTop; }).get();
    block.each(function(i) { $(this).css({ position: 'absolute', top: tops[i] + 'px', left: 0, right: 0 }); });
    block.addClass('covered');
    var below = block.last().nextAll();
    el.leaving = { block: block, below: below, list: list };
    el.leaveTimer = glide(list, below, height, oldHeight, closeTime, function() {
      el.leaving.gone = true;
      if (el.landing) el.landing();
    });
  }, tickPause);
}

// Put a leaving row back as it was, its slide undone.
function stopLeaving(row) {
  var el = row[0], l = el.leaving;
  clearTimeout(el.leaveTimer);
  el.leaveTimer = el.leaving = el.landing = null;
  row.removeClass('leaving');
  if (!l) return;
  l.block.removeClass('covered').css({ position: '', top: '', left: '', right: '' });
  l.below.removeClass('covering').css({ transition: '', transform: '' });
  $(l.list).css({ position: '', transition: '', height: '', overflow: '' });
}

// Google has said yes: move it once it has slid away (or now, if it wasn't going to).
function landed(row, checkbox, move) {
  var el = row[0];
  function land() {
    stopLeaving(row);
    if (checkbox.prop('checked')) move();
    renderMeta(row);
    refreshRows();
  }
  if (!row.hasClass('leaving') || !el.leaveTimer) return land();
  if (el.leaving && el.leaving.gone) return land();
  el.landing = land; // when the slide is done
}

// "Task marked uncompleted", as Google Tasks says, with Undo.
function untickedMessage(todo) {
  var can = function() { return live(todo).length && !live(todo).hasClass('checked'); };
  var undo = function() { undoTick([todo], true); };
  canUndo(can, undo);
  if (!removals.length) showMessage('Task marked uncompleted.', 'Undo', function() { if (can()) undo(); }, 7000);
}

// Reopened: straight back to the open tasks, under those there, which slide down off it.
function reopenRow(row, todo, card) {
  var along = subtaskRows(todo);
  row.removeClass('selected');
  if (openParent(todo).length) placeSubtask(todo);
  else card.find('.claire').prepend(row.removeClass('subtask'), along.addClass('subtask'));
  sortDone(card);
  renderMeta(row);
  autosize(todo); // its own size: the rest waits until it has slid open
  slideOpen(row.add(along), refreshRows);
}

function setCompleted(checkbox, after, quiet, failed) {
  var todo = checkbox.siblings('.todo');
  var row = todo.parent();
  var done = checkbox.prop('checked');
  row[0].tickedAt = Date.now();
  if (done && row.parent().is('.claire') && !openParent(todo).length) {
    row.addClass('leaving');
    startLeaving(row, checkbox);
  } else if (!done && row.hasClass('leaving')) stopLeaving(row); // unticked during the pause
  if (!quiet || done) pop(checkbox, done);
  var id = todo.attr('id');
  var card = todo[0].card;
  if (!done && id && todo[0].parentTask && row.parent().is('.done-list')) return reopenParent(checkbox, after, quiet);
  todo.toggleClass('checked', done);
  if (!id) return; // saveTask sends it once the task exists
  var wasDone = row.parent().is('.done-list'), completedAt = todo[0].completedAt;
  // Said at once, as Google Tasks does; a task with open subtasks waits to hear what
  // Google did with them
  var told = !quiet && (!done || !subtaskRows(todo).children('.todo').not('.checked').length);
  if (told) {
    if (done) offerUntick(checkbox, [], quiet);
    else untickedMessage(todo);
  }
  if (!done && wasDone) { // at once, as Google Tasks does (after its ripple): put back if Google says no
    todo[0].completedAt = undefined; // so no "Completed" line
    clearTimeout(row[0].reopenTimer);
    row[0].reopenTimer = setTimeout(function() {
      if (!checkbox.prop('checked') && row.parent().is('.done-list')) reopenRow(row, todo, card);
    }, reopenDelay);
  }
  ticking++;
  api(todo, 'PATCH', '/' + id, done ? { status: 'completed' } : { status: 'needsAction', completed: null }, function(result) {
    ticking--;
    if (checkbox.prop('checked') !== done) return; // changed again since
    todo[0].completedAt = done ? (result && result.completed) || new Date().toISOString() : undefined;
    if (todo[0].deleted) return;
    var here = row.parent().is('.claire');
    if (here && (!done || openParent(todo).length)) {
      refreshRows();
      if (done) offerUntick(checkbox, [], quiet);
    } else if (done) {
      var subtasks = subtaskRows(todo).children('.todo');
      var open = subtasks.not('.checked').get();
      if (open.length) followSubtasks(checkbox, open, quiet);
      else if (!told) offerUntick(checkbox, [], quiet);
      landed(row, checkbox, function() {
        row.removeClass('selected');
        card.find('.done-list').prepend(row, subtaskRows(todo).children('.todo.checked').parent().removeClass('selected'));
        sortDone(card);
      });
    } else if (row.parent().is('.done-list')) {
      clearTimeout(row[0].reopenTimer);
      reopenRow(row, todo, card);
    }
    renderMeta(row);
    countDone(card);
    if (!done && !quiet && !told) untickedMessage(todo);
    if (after) after();
    if (!here && !done) reload(card); // puts it back in its place, unless more are on the way
  }, function(status) {
    ticking--;
    if (row[0].leaving || row.hasClass('leaving')) stopLeaving(row);
    checkbox.prop('checked', !done);
    todo.toggleClass('checked', !done);
    if (!done && wasDone) { // back to Completed
      clearTimeout(row[0].reopenTimer);
      todo[0].completedAt = completedAt;
      if (row.parent().is('.claire')) card.find('.done-list').prepend(row.add(subtaskRows(todo)));
      sortDone(card);
      renderMeta(row);
      refreshRows();
    }
    showFailure('Could not update that task.', status);
    if (failed) failed();
  });
}

// Unticking a completed subtask reopens its parent too. The others come back with
// it, still ticked. The parent goes first: Google shouldn't see an open subtask
// under a completed task.
function reopenParent(checkbox, after, quiet) {
  var todo = checkbox.siblings('.todo'), id = todo[0].parentTask, card = todo[0].card;
  var parent = card.find('.done-list .todo').filter(function() { return this.id === id; });
  function undo() { // the subtask first, then its parent
    var sub = live(todo).siblings('input[type=checkbox]'), top = live(parent).siblings('input[type=checkbox]');
    setCompleted(sub.prop('checked', true), function() {
      if (top.length) setCompleted(top.prop('checked', true), null, true);
    }, true);
  }
  function subtask() {
    untick(function() {
      if (!quiet) canUndo(function() { return live(todo).length && !live(todo).hasClass('checked'); }, undo);
      if (after) after();
      reload(card);
    });
  }
  function untick(then) {
    var was = todo[0].parentTask, list = todo.closest('ul');
    if (list.is('.done-list')) todo[0].parentTask = undefined; // its parent isn't on screen
    setCompleted(checkbox, then, true);
    todo[0].parentTask = was;
  }
  function back() {
    checkbox.prop('checked', true);
  }
  if (parent.length) return setCompleted(parent.siblings('input[type=checkbox]').prop('checked', false), subtask, true, back);
  api(todo, 'GET', '/' + id, null, function(task) {
    if (!task || task.status !== 'completed') return subtask();
    api(todo, 'PATCH', '/' + id, { status: 'needsAction', completed: null }, function() {
      card[0].doneWaiting = $.grep(card[0].doneWaiting, function(waiting) { return waiting.id !== id; });
      subtask();
    }, function(status) {
      back();
      showFailure('Could not update that task.', status);
    });
  }, subtask); // gone: reopen it on its own
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
  var left = subtasks.length, moved = [], card = subtasks[0].card;
  function next() {
    if (--left) return;
    if (moved.length) sortDone(card);
    offerUntick(checkbox, moved, quiet);
    reload(card);
  }
  $.each(subtasks, function(i, el) {
    var todo = $(el), row = todo.parent();
    if (!el.id) return next();
    api(todo, 'GET', '/' + el.id, null, function(task) {
      var open = row.parent().is('.claire') && !el.deleted;
      if (open && task && task.status === 'completed') {
        saveTask(todo);
        el.completedAt = doneDate(task);
        todo.addClass('checked');
        moved.push(todo.siblings('input[type=checkbox]').prop('checked', true)[0]);
        card.find('.done-list').append(row.removeClass('selected'));
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

// A task Google hasn't made yet has a key of its own, so that rows can be put under
// it straight away. Its subtasks are made, and moved, once it has an id.
var newRows = 0;

function taskKey(el) {
  return el.id || el.localId;
}

function isLocal(key) {
  return /^new-/.test(key || '');
}

function byKey(key) {
  return $('ul.list .todo').filter(function() { return taskKey(this) === key; });
}

// Values are set with .val() and .text(), so quotes and HTML stay as text.
function taskRow(task, card) {
  var done = task.status === 'completed';
  var todo = $('<textarea class="todo" rows="1" placeholder="Title" aria-label="Task"></textarea>').toggleClass('checked', done)
    .val(text(task.title));
  var notes = $('<textarea class="notes" rows="1" placeholder="Details" aria-label="Details"></textarea>').val(text(task.notes));
  var due = $('<input type="date" class="due" aria-label="Due date" min="2000-01-01" max="2999-12-31"/>').val((task.due || '').slice(0, 10));
  var row = $('<li></li>').toggleClass('subtask', !!task.parent).append(
    $('<span class="handle" title="Drag to move" aria-hidden="true">&#8942;&#8942;</span>'),
    $('<input type="checkbox" aria-label="Completed"/>').prop('checked', done),
    todo,
    $('<button type="button" class="more" aria-label="Task options" aria-haspopup="true" aria-expanded="false">&#8942;</button>'),
    $('<div class="meta"><span class="when"></span><span class="preview"></span></div>'),
    // Shown while the task is being edited, as in Google Tasks
    $('<div class="details"></div>').append(
      $('<label class="notes-line"><svg class="icon" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 5h12M3 9h12M3 13h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg></label>').append(notes),
      $('<div class="dates"></div>').append(
        '<button type="button" class="chip" data-due="0">Today</button>',
        '<button type="button" class="chip" data-due="1">Tomorrow</button>',
        $('<span class="pick"></span>').append('<button type="button" class="chip pick-date" aria-label="Pick a date"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span class="pick-label"></span></button>', due),
        '<button type="button" class="chip clear-due" aria-label="Clear date">&times;</button>')),
    $('<div class="menu" role="menu"></div>').append($.map([
      ['select', 'Select'], ['details', 'Notes and due date'], ['subtask', 'Add a subtask'], ['indent', 'Make subtask'], ['outdent', 'Move out'],
      ['top', 'Move to top'], ['up', 'Move up'], ['down', 'Move down'], ['delete', 'Delete']
    ], function(item) {
      return $('<button type="button" role="menuitem"></button>').attr('data-move', item[0]).text(item[1]);
    }))
  );
  if (task.id) todo.attr('id', task.id);
  else todo[0].localId = 'new-' + (++newRows);
  todo[0].card = card;
  todo[0].parentTask = todo[0].googleParent = task.parent;
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

// ---- Dates typed at the end of a title: "Pay rent fri", "Dentist tomorrow",
// "Mum's birthday on 5 dec". Read when you leave the title, if the task has no date.

var WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The title without the date, and the date as 2026-11-25, or null if it doesn't end
// in one. now is for tests.
function typedDate(text, now) {
  now = now || new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  function after(days) { return new Date(today.getFullYear(), today.getMonth(), today.getDate() + days); }
  var weekday = '(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?';
  var month = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
  var rules = [
    [/^(?:today|tod)$/, function() { return today; }],
    [/^(?:tomorrow|tmrw|tmr|tomorow)$/, function() { return after(1); }],
    [/^next week$/, function() { return after(((8 - today.getDay()) % 7) || 7); }], // Monday
    [new RegExp('^(next )?' + weekday + '$'), function(m) {
      var want = WEEKDAYS.indexOf(m[2].slice(0, 3)), ahead = ((want - today.getDay() + 7) % 7) || 7;
      return after(ahead + (m[1] ? 7 : 0));
    }],
    [/^in (\d{1,3}) (day|days|week|weeks)$/, function(m) { return after(+m[1] * (m[2].charAt(0) === 'w' ? 7 : 1)); }],
    [new RegExp('^(\\d{1,2})(?:st|nd|rd|th)? ' + month + '$'), function(m) { return dayOf(+m[1], m[2]); }],
    [new RegExp('^' + month + ' (\\d{1,2})(?:st|nd|rd|th)?$'), function(m) { return dayOf(+m[2], m[1]); }],
    [/^(\d{1,2})\/(\d{1,2})$/, function(m) { return dayOf(+m[1], MONTHS[+m[2] - 1]); }] // day/month, as in the UK
  ];
  // The next such day, this year or next; none if it isn't a real date
  function dayOf(day, name) {
    var m = MONTHS.indexOf((name || '').slice(0, 3));
    if (m < 0 || day < 1) return null;
    var d = new Date(today.getFullYear(), m, day);
    if (d.getMonth() !== m) return null;
    return d < today ? new Date(today.getFullYear() + 1, m, day) : d;
  }
  var words = text.replace(/\s+$/, '').split(/\s+/);
  for (var take = Math.min(3, words.length - 1); take >= 1; take--) { // the longest ending first
    var end = words.slice(-take).join(' ').toLowerCase(), rest = words.slice(0, -take);
    for (var i = 0; i < rules.length; i++) {
      var m = end.match(rules[i][0]), date = m && rules[i][1](m);
      if (!date) continue;
      if (/^(on|by|due)$/i.test(rest[rest.length - 1] || '') && rest.length > 1) rest.pop();
      return { title: rest.join(' '), due: isoDay(date) };
    }
  }
  return null;
}

// On leaving a title you changed: take a date off its end, with an undo.
function takeDate(todo) {
  var el = todo[0];
  if (!el || el.deleted || todo.hasClass('checked')) return;
  var now = current(todo);
  if (now.due || now.title === (el.saved && el.saved.title) || now.title === el.keptTitle) return;
  var found = typedDate(now.title);
  if (!found || !found.title) return;
  setValues(todo, $.extend({}, now, found));
  var undone = false;
  function undo() {
    undone = true;
    el.keptTitle = now.title; // as you want it: not read again unless you change it
    setValues(todo, $.extend(current(todo), { title: now.title, due: '' }));
    el.lastTitle = now.title;
    saveSoon(todo);
  }
  canUndo(function() { return !undone && $.contains(document, el) && current(todo).due === found.due; }, undo);
  showMessage('Due ' + dayName(found.due) + '.', 'Undo', undo, 5000);
}

// Today, or so many days from it, as 2026-11-25.
function dayFrom(days) {
  var now = new Date();
  return isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
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
  var completedAt = !row.hasClass('leaving') && row.children('.todo')[0].completedAt; // not until it's in Completed
  var when = completedAt ? 'Completed: ' + dayName(isoDay(new Date(completedAt)))
    : values.due ? (overdue ? 'Overdue: ' : '') + dayName(values.due) : '';
  row.find('.when').text(when).toggleClass('overdue', !!overdue);
  row.find('.preview').text(values.notes.split('\n')[0]);
  // Set outright: jQuery 3's toggle() can't show what the stylesheet hides in a row not yet on the page
  row.children('.meta').css('display', when || values.notes ? 'block' : 'none');
  var other = values.due && values.due !== dayFrom(0) && values.due !== dayFrom(1);
  row.find('[data-due]').each(function() { $(this).toggleClass('on', values.due === dayFrom(+$(this).attr('data-due'))); });
  row.find('.pick-date').toggleClass('on', !!other).toggleClass('overdue', !!(other && overdue)).find('.pick-label').text(other ? dayName(values.due) : '');
  row.find('.clear-due').toggle(!!values.due);
  row.children('.handle').toggleClass('off', row.children('.todo').hasClass('checked'));
  // What a screen reader says: which task each control is for, and what's switched on
  var todo = row.children('.todo'), title = $.trim(values.title) || 'new task', meta = row.children('.meta');
  if (!meta.attr('id')) meta.attr('id', 'meta-' + (++metas));
  todo.attr({ 'aria-label': row.hasClass('subtask') ? 'Subtask' : 'Task', 'aria-describedby': meta.attr('id') });
  row.children('input[type=checkbox]').attr('aria-label', (todo.hasClass('checked') ? 'Reopen ' : 'Complete ') + title);
  row.children('.more').attr('aria-label', 'Options for ' + title);
  row.find('[data-due]').each(function() { $(this).attr('aria-pressed', String($(this).hasClass('on'))); });
  row.find('.pick-date').attr('aria-label', other ? 'Due ' + dayName(values.due) + ', pick another date' : 'Pick a date');
}
var metas = 0;

function subtaskRows(todo) {
  var id = todo[0] && taskKey(todo[0]);
  return todo.closest('ul').find('.todo').filter(function() { return id && this.parentTask === id; }).parent();
}

// A completed task whose subtasks are still open: deleting it could take them too.
function hasOpenSubtasks(todo) {
  var id = todo.attr('id');
  if (!todo.closest('.done-list').length) return false;
  if (!todo[0].card.find('.claire .todo').filter(function() { return id && this.parentTask === id; }).length) return false;
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

// Where to create or move a task: after the sibling above it, or first. Google
// hides ticked ones, and refuses one that it doesn't have under the same parent
// yet, as it is still waiting to be moved there.
function placement(todo) {
  var parent = todo[0].parentTask;
  var above = siblingAbove(todo, function(el) { return el.id && !$(el).hasClass('checked') && el.googleParent === parent; });
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
  // A new task goes after the one above it at Google, so wait for moves among the
  // tasks around it to land first: one moved there a moment ago may not be there yet.
  // (Only those: a move waiting for this task to be made must not hold it up.)
  if (!id && moves.some(function(other) {
    var o = other[0];
    return o !== el && o.parentTask === el.parentTask && o.card && el.card && o.card[0] === el.card[0];
  })) return saveSoon(todo);
  if (!id && isLocal(el.parentTask)) { // its parent is still being made
    var parent = byKey(el.parentTask);
    if (parent.length) {
      saveTask(parent);
      return saveSoon(todo);
    }
    el.parentTask = undefined; // it went
    todo.parent().removeClass('subtask');
  }
  var sent = current(todo);
  el.saving = true;
  api(todo, id ? 'PATCH' : 'POST', id ? '/' + id : placement(todo), changes(todo), function(result) {
    el.saving = el.failed = false;
    el.saved = sent;
    if (!id) {
      todo.attr('id', result.id);
      el.googleParent = result.parent;
      $('ul.list .todo').each(function() { if (this.parentTask === el.localId) this.parentTask = result.id; });
      if (el.gone) return deleteTask(todo);
      if (el.parentTask !== result.parent) moveTask(todo); // indented or moved out while being made
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

// Make whatever fn adds to the undo list one entry, which undoes it last first.
function asOneUndo(fn) {
  var start = undoStack.length;
  fn();
  var entries = undoStack.splice(start);
  if (!entries.length) return;
  canUndo(function() {
    return entries.some(function(entry) { return entry.can(); });
  }, function() {
    entries.slice().reverse().forEach(function(entry) { if (entry.can()) entry.run(); });
  });
}

// Do something without adding it to the undo list, as part of something that is.
function withoutUndo(fn) {
  var was = undoing;
  undoing = true;
  try {
    fn();
  } finally {
    undoing = was;
  }
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
      setCompleted($(box), function() { reload($(box).siblings('.todo')[0].card); }, true);
    });
  }, true);
}

// ---- Deleting and joining, with undo

var removals = []; // rows hidden but not yet deleted from Google, oldest first

// Hide tasks and their subtasks now, and delete them in a few seconds, unless undone.
function removeRow(todo, message, onUndo) {
  var rows = todo.parent();
  todo.each(function() { rows = rows.add(subtaskRows($(this))); });
  var subtasks = rows.length - 1;
  var removal = { todos: rows.children('.todo'), list: todo.first().parent().parent(), onUndo: onUndo };
  rows.each(function() { // where each goes back, as they needn't be next to each other
    this.wasAfter = this.previousElementSibling;
    this.wasBefore = $(this).nextAll('li').not(rows)[0];
  });
  removal.text = message || (todo.length > 1 ? rows.length + ' tasks deleted.'
    : 'Task ' + (subtasks ? 'and ' + subtasks + ' subtask' + (subtasks > 1 ? 's ' : ' ') : '') + 'deleted.');
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
  todos.each(function() { // in order, so a row's neighbour above is back before it
    var row = this.parentNode;
    if (row.wasAfter && $.contains(r.list[0], row.wasAfter)) $(row.wasAfter).after(row);
    else if (row.wasBefore && $.contains(r.list[0], row.wasBefore)) $(row.wasBefore).before(row);
    else r.list.append(row);
  });
  if (r.list.is('.done-list')) sortDone(r.todos[0].card);
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
  if (r.list.is('.done-list')) countDone(r.todos[0].card);
}

function deleteTask(todo, removal) {
  var id = todo.attr('id');
  if (!id) return; // never saved, or saveTask deletes it once it has an id
  api(todo, 'DELETE', '/' + id, null, null, function(status) {
    if (status === 404) return; // already deleted
    if (removal) putBack(removal, todo);
    showFailure('Could not delete that task.', status);
  });
}

// Join a row's text, notes and date onto the one before it, and remove it. Its
// subtasks go to the joined task, or to that task's parent if it is a subtask, as
// Google has one level.
function mergeRows(target, source) {
  if (hasOpenSubtasks(source)) return;
  var subtasks = subtaskRows(source);
  if (subtasks.children('.todo.checked').length) { // Google won't move a completed task under another
    showMessage('That task has completed subtasks, so it can\u2019t be joined.', null, null, 4000);
    return;
  }
  var before = current(target), from = current(source), key = taskKey(source[0]);
  var parent = target.parent().hasClass('subtask') ? target[0].parentTask : taskKey(target[0]);
  var todos = subtasks.children('.todo');
  function adopt(todos, parent) { // where they are, so the undo list only has the join
    withoutUndo(function() {
      todos.each(function() { place($(this), $(this).parent().next(), parent); });
    });
  }
  adopt(todos, parent);
  function giveBack() {
    adopt($($.map(todos.get(), function(el) { return live($(el)).get(); })), key);
  }
  if (!from.title) return removeBlank(source, target, before.title.length, giveBack); // its notes and date go with it
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
    giveBack();
  });
}

// Delete a row with no title, and any notes or date. Undo brings back the title it
// had, and then calls onUndo.
function removeBlank(todo, next, caret, onUndo) {
  var el = todo[0];
  if (hasOpenSubtasks(todo)) return;
  var values = current(todo);
  if (!todo.attr('id') && !el.saving && !values.notes && !values.due) { // nothing to undo
    todo.parent().remove();
    refreshRows();
  } else {
    var title = el.lastTitle || '';
    removeRow(todo, null, function() {
      setValues(todo, $.extend(current(todo), { title: title }));
      if (onUndo) onUndo();
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

// ---- Moving. Rows are put in place first, then Google is told one move at a time,
// each to where the row is by then. A task's googleParent is its parent at Google.

var moves = [];

function moveTask(todo) {
  moves.push(todo);
  if (moves.length === 1) nextMove();
}

function nextMove() {
  var todo = moves[0];
  if (!todo) return;
  var id = todo.attr('id'), parent = todo[0].parentTask;
  if (isLocal(parent) && byKey(parent).length) { // wait for its new parent to be made
    saveTask(byKey(parent));
    return setTimeout(nextMove, 250);
  }
  // A new parent must be at the top level at Google first
  var first = parent && $.grep(moves, function(other) { return other.attr('id') === parent && other[0].googleParent; })[0];
  if (first) {
    moves.splice($.inArray(first, moves), 1);
    moves.unshift(first);
    return nextMove();
  }
  function done() {
    moves.shift();
    nextMove();
  }
  if (!id || todo[0].deleted) return done(); // a new task is created in its place
  api(todo, 'POST', '/' + id + '/move' + placement(todo), null, function() {
    todo[0].googleParent = parent;
    done();
  }, function(status) {
    moves = [];
    showFailure('Could not move that task.', status);
    reload(todo[0].card); // back to how Google has it
  });
}

// Put a row, with its subtasks, before another row (or last) under a parent (or none).
function place(todo, before, parent) {
  var rows = todo.parent().add(subtaskRows(todo));
  var was = { above: todo.parent().prev()[0], parent: todo[0].parentTask };
  var above = todo.parent().prev().children('.todo'), below = rows.last().next().children('.todo');
  if (before && before.length) before.before(rows);
  else todo[0].card.find('.claire').append(rows);
  todo[0].parentTask = parent;
  todo.parent().toggleClass('subtask', !!parent);
  renderMeta(todo.parent()); // "Task" or "Subtask"
  refreshRows();
  if (was.above === todo.parent().prev()[0] && was.parent === parent) return;
  moveTask(todo);
  canUndo(function() { return live(todo).closest('.claire').length; }, function() {
    var back = live(above).closest('.claire li'), next = live(below).closest('.claire li');
    var row = live(todo);
    place(row, next.length ? next : back.length ? back.nextAll('li').not(row.parent().add(subtaskRows(row))).first() : above.length ? $() : row[0].card.find('.claire li').first(), was.parent);
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
  var card = el.card;
  card.find('.done-list').append(row);
  sortDone(card);
  showMessage('Moved to Completed.', null, null, 4000);
  api(todo, 'POST', '/' + el.id + '/move', null, function() { el.googleParent = undefined; }, function(status) {
    el.parentTask = parent;
    if (list.is('.claire') && openParent(todo).length) placeSubtask(todo);
    sortDone(card);
    showFailure('Could not move that task.', status);
  });
  return true;
}

function moveRow(todo, how) {
  var row = todo.parent();
  if (searchWords().length && how !== 'subtask') { // the tasks it would move past may be hidden
    showMessage('Clear the search to move or indent tasks.', null, null, 4000);
    return true;
  }
  if (how === 'outdent' && todo.hasClass('checked') && row.hasClass('subtask')) return moveOutTicked(todo);
  if (!row.parent().is('.claire') || todo.hasClass('checked')) return;
  var sub = row.hasClass('subtask');
  var caret = document.activeElement === todo[0] ? [todo[0].selectionStart, todo[0].selectionEnd] : null;
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
    var parent = row.prev().hasClass('subtask') ? above[0].parentTask : taskKey(above[0]);
    if (!parent) return;
    // Google has one level, so its own subtasks become the new parent's, where they are
    var own = family(row).not(row);
    if (own.children('.todo.checked').length) { // Google won't move a completed task under another
      showMessage('That task has completed subtasks, so it can\u2019t become one.', null, null, 4000);
      return true; // dealt with: don't move focus as well
    }
    asOneUndo(function() { // its subtasks first: Google won't put a task that has some under another
      own.each(function() { place($(this).children('.todo'), $(this).next(), parent); });
      place(todo, row.next(), parent);
    });
    moved = true;
  } else if (how === 'outdent' && sub) {
    // It stays where it is, and the subtasks below it become its own
    var below = row.nextUntil('li:not(.subtask)'), open = below.filter(function() { return !$(this).children('.todo').hasClass('checked'); });
    asOneUndo(function() {
      row.before(below.not(open)); // Google won't put a completed task under another, so those stay
      place(todo, row.next(), undefined);
      open.each(function() { place($(this).children('.todo'), $(this).next(), taskKey(todo[0])); });
    });
    moved = true;
  }
  if (caret) todo.setCursorPosition(caret[0], caret[1]);
  return moved;
}

function addSubtask(todo) {
  var id = taskKey(todo[0]);
  if (todo.parent().hasClass('subtask')) return; // Google only has one level
  var row = taskRow({ parent: id }, todo[0].card);
  family(todo.parent()).last().after(row);
  refreshRows();
  row.children('.todo').focus();
}

// Move tasks to another list, under the given task there or at the top. Several go
// one at a time, the last first, so that they keep their order.
function moveToList(todos, id, previous) {
  var from = todos[0].card, to = cardFor(id), several = todos.length > 1;
  if (id === from[0].list) return;
  if (todos.toArray().some(function(el) { return subtaskRows($(el)).length; })) {
    return showMessage((several ? 'One of those tasks has' : 'That task has') + ' subtasks, so it can’t change list.', null, null, 4000);
  }
  var unmade = todos.filter(function() { return !this.id; });
  if (unmade.length) return showMessage(unmade.val() ? 'Still saving that task. Try again in a moment.' : 'Give that task a title first.', null, null, 4000);
  function call(source, what, target, after, done, failed) {
    if (shared.isShared(source) || shared.isShared(target)) return shared.move(source, what, target, after, done, failed);
    send('POST', 'lists/' + encodeURIComponent(source) + '/tasks/' + encodeURIComponent(what) + '/move?destinationTasklist=' + encodeURIComponent(target) +
      (after ? '&previous=' + encodeURIComponent(after) : ''), null, done, failed);
  }
  settle('Move anyway', function() {
    var rows = todos.parent(), after = rows.last().next();
    var was = siblingAbove(todos.first(), function(el) { return el.id && !$(el).hasClass('checked'); });
    var list = findList(id), name = (list || {}).title, moved = [];
    function count(by) {
      if (list && !to.length && typeof list.count === 'number') list.count += by;
    }
    todos.each(function() { this.deleted = true; }); // on their way
    rows.removeClass('selected').detach();
    refreshRows();
    function step(i) {
      if (i < 0) return arrived();
      var el = todos[i];
      call(from[0].list, el.id, id, previous, function(result) {
        el.gone = true;
        moved.unshift((result && result.id) || el.id);
        count(1);
        step(i - 1);
      }, function(status) {
        var left = todos.slice(0, i + 1); // not moved
        left.each(function() { this.deleted = false; });
        if (after.length && $.contains(document, after[0])) after.before(left.parent());
        else from.find('.claire').append(left.parent());
        refreshRows();
        if (list) showCount(list);
        if (moved.length && to.length) reload(to);
        showFailure('Could not move ' + (several ? 'those tasks.' : 'that task.'), status);
      });
    }
    function arrived() {
      if (list) showCount(list);
      if (to.length) reload(to);
      var used = false;
      function back() { // the last first again, each under the task that was above them
        used = true;
        function stepBack(i) {
          if (i < 0) {
            if (list) showCount(list);
            if (to.length) reload(to);
            return reload(from);
          }
          call(id, moved[i], from[0].list, was && was.id, function() {
            count(-1);
            stepBack(i - 1);
          }, function(status) {
            showFailure('Could not move ' + (several ? 'them' : 'it') + ' back.', status);
            if (to.length) reload(to);
            reload(from);
          });
        }
        stepBack(moved.length - 1);
      }
      canUndo(function() { return !used; }, back);
      showMessage('Moved ' + (several ? moved.length + ' tasks ' : '') + 'to ' + name + '.', 'Undo', back, 7000);
    }
    step(todos.length - 1);
  });
}

// Last chance as the page closes: requests that outlive it.
function flush() {
  if (!signedIn()) return;
  var headers = { 'Authorization': 'Bearer ' + auth.token(), 'Content-Type': 'application/json' };
  function url(el) { return API + 'lists/' + encodeURIComponent(el.card[0].list) + '/tasks'; }
  function isSharedRow(el) { return el.card && shared.isShared(el.card[0].list); }
  $('.todo').each(function() {
    var el = this, todo = $(el), id = todo.attr('id'), sent = current(todo);
    if (isSharedRow(el)) return saveTask(todo); // made in the page at once, and saved below
    if (!isUnsaved(todo) || (el.saving && !id)) return;
    clearTimeout(el.timer);
    el.saving = true;
    fetch(url(el) + (id ? '/' + id : placement(todo)), { method: id ? 'PATCH' : 'POST', headers: headers, keepalive: true, body: JSON.stringify(changes(todo)) })
      .then(function(r) { if (!r.ok) throw r; return r.json(); })
      .then(function(task) { todo.attr('id', task.id); el.saved = sent; })
      .catch(function() {})
      .then(function() { el.saving = false; });
  });
  $.each(moves.slice(1), function(i, todo) { // the first is already on its way
    var id = todo.attr('id');
    if (isSharedRow(todo[0])) return;
    if (id && !todo[0].deleted) fetch(url(todo[0]) + '/' + id + '/move' + placement(todo), { method: 'POST', headers: headers, keepalive: true }).catch(function() {});
  });
  moves.length = Math.min(moves.length, 1);
  $.each(removals.splice(0), function(i, r) {
    clearTimeout(r.timer);
    $(r.todos.get().reverse()).each(function() {
      this.gone = true;
      if (isSharedRow(this)) return deleteTask($(this));
      if (this.id) fetch(url(this) + '/' + this.id, { method: 'DELETE', headers: headers, keepalive: true }).catch(function() {});
    });
  });
  shared.flush();
  if (undoShown) hideMessage();
}

$(window).on('pagehide', flush);

function newTask(card) {
  if (!signedIn()) return handleAuthClick();
  if (!card || !card.length) card = $('#cards .card').first();
  if (!card.length) return showMessage('Show a list first.', null, null, 4000);
  var row = taskRow({}, card);
  card.find('.claire').prepend(row);
  refreshRows();
  row.children('.todo').focus();
}
