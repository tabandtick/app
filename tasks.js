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
                $("#claire").append($("<li><input type='text' class='todo " + (taskList.status === 'completed'?'checked':'') + "' id=" + taskList.id + " value='" + taskList.title + "'></input><input " + (taskList.status === 'completed'?'checked':'') + " type='checkbox'/></li>"));
                updateToDoCount();
                toggleToDoCheckboxes();
              }
            } else {
              $(document.body).append($("<p>No tasks</p>"));
            }
          });
      }

function completeTask(completedID, gAPI, task) {
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
  gapi.client.request({
      path: 'https://www.googleapis.com/tasks/v1/lists/' + TASK_LIST + '/tasks/' + deletedID,
      method: 'DELETE'
  }).execute();
}

function insertTask(gAPI, task) {
  gapi.client.request({
      path: 'https://www.googleapis.com/tasks/v1/lists/' + TASK_LIST + '/tasks',
      method: 'POST',
      body:
          {
          }
  }).execute();
  // console.log(request.id);
  // $("#claire").append($("<li><input type='text' class='todo " + (taskList.status === 'completed'?'checked':'') + "' id=" + taskList.id + " value='" + taskList.title + "'></input><input " + (taskList.status === 'completed'?'checked':'') + " type='checkbox'/></li>"));
}
