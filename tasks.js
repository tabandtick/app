var CLIENT_ID = '146982777170-h1btpb05ltctf58n4f9foqof665i08j7.apps.googleusercontent.com';
var SCOPES = ['https://www.googleapis.com/auth/tasks'];
// The signed-in user's own default list.
var TASK_LIST = '@default';

function checkAuth() {
  gapi.auth.authorize(
    {
      'client_id': CLIENT_ID,
      'scope': SCOPES.join(' '),
      'immediate': true
    }, handleAuthResult);
}

function handleAuthResult(authResult) {
  var authorizeDiv = document.getElementById('authorize-div');
  if (authResult && !authResult.error) {
    authorizeDiv.style.display = 'none';
    loadTasksApi();
  } else {
    authorizeDiv.style.display = 'inline';
  }
}

function handleAuthClick(event) {
  gapi.auth.authorize(
    {client_id: CLIENT_ID, scope: SCOPES, immediate: false},
    handleAuthResult);
  return false;
}

function loadTasksApi() {
  gapi.client.load('tasks', 'v1', listTaskLists);
}

function listTaskLists() {
    var request = gapi.client.tasks.tasks.list({
            'tasklist': TASK_LIST
          });

          request.execute(function(resp) {
            var taskLists = resp.items;
            if (taskLists && taskLists.length > 0) {
              for (var i = 0; i < taskLists.length; i++) {
                var taskList = taskLists[i];
                // console.log(taskList);
                $("#claire").append(taskRow(taskList));
                updateToDoCount();
                toggleToDoCheckboxes();
              }
            } else {
              $(document.body).append($("<p>No tasks</p>"));
            }
          });
      }

function completeTask(completedID, gAPI, task) {
  if (!completedID) return; // not saved to Google yet
  gapi.client.request({
      path: 'https://www.googleapis.com/tasks/v1/lists/' + TASK_LIST + '/tasks/' + completedID,
      method: 'PATCH',
      body:
          {
            id: completedID,
            status: 'completed'
          }
  }).execute();
}

function uncompleteTask(uncompletedID, gAPI, task) {
  if (!uncompletedID) return; // not saved to Google yet
  gapi.client.request({
      path: 'https://www.googleapis.com/tasks/v1/lists/' + TASK_LIST + '/tasks/' + uncompletedID,
      method: 'PATCH',
      body:
          {
            id: uncompletedID,
            status: 'needsAction',
            completed: null
          }
  }).execute();
}

function deleteTask(deletedID, gAPI, task) {
  if (!deletedID) return; // not saved to Google yet
  gapi.client.request({
      path: 'https://www.googleapis.com/tasks/v1/lists/' + TASK_LIST + '/tasks/' + deletedID,
      method: 'DELETE'
  }).execute();
}

// Set the title with .val() so quotes and HTML in it are treated as text.
function taskRow(task) {
  var done = task.status === 'completed';
  var todo = $('<input type="text" class="todo"/>').toggleClass('checked', done).val(task.title || '');
  if (task.id) todo.attr('id', task.id);
  todo[0].savedTitle = task.title || '';
  return $('<li></li>').append(todo, $('<input type="checkbox"/>').prop('checked', done));
}

// State lives on the element, not in .data(): removing a focused row fires
// focusout after jQuery has already cleared its data.
// Save a row's text: create the task the first time, then update its title.
function saveTitle(todo) {
  var title = todo.val();
  var id = todo.attr('id');
  var el = todo[0];
  if (!el || el.saving || el.deleted || title === (el.savedTitle || '')) return;
  if (!id && !title) return;
  el.saving = true;
  gapi.client.request({
      path: 'https://www.googleapis.com/tasks/v1/lists/' + TASK_LIST + '/tasks' + (id ? '/' + id : ''),
      method: id ? 'PATCH' : 'POST',
      body: { title: title }
  }).execute(function(resp) {
    el.saving = false;
    if (!resp || resp.error) {
      console.error('Could not save task', resp && resp.error);
      return;
    }
    // Deleted from the page while it was being created.
    if (!id && el.deleted) return deleteTask(resp.id);
    todo.attr('id', resp.id);
    el.savedTitle = title;
    saveTitle(todo); // the text may have changed while saving
  });
}

function newTask() {
  if (!gapi.auth.getToken()) return handleAuthClick();
  var row = taskRow({});
  $('#claire').prepend(row);
  row.children().first().focus();
}
