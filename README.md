# MyTo.Do

A simple to-do list for Google Tasks: https://mytodo.github.io/MyTo.Do/

It is a static page with no server or build step. It signs in with Google and
works on your default task list.

## Using it

- **New Task** adds a task at the top. It is saved once it has a title.
- **Typing** in a row edits its title, and saves shortly after you stop.
- **The tick box** completes a task and moves it to Completed, or reopens it.
- **...** shows a task's notes and due date, and buttons to move it, add a
  subtask or delete it. Overdue dates are red.
- **Completed** lists the last 30 days, then a year, then everything.
- **Delete Task** deletes the task you last clicked, marked with a blue bar, and
  any subtasks, and moves to the next one.
- **Enter** splits a row into two tasks.
- **Backspace** at the start of a row joins it to the one above, with its notes.
- **Delete** at the end of a row joins the next one to it.
- **Drag the dots** to move a task. Drag right to make it a subtask, left to move
  it out. The buttons under **...** do the same.
- **Alt+up/down** moves a task. **Cmd/Ctrl+]** makes it a subtask and **[** moves it
  out.
- **Up and down arrows** move between rows.

Completing, deleting and joining can be undone for 7 seconds, latest delete first. Google is only
told to delete anything once that time is up, or when the page closes. A task
with subtasks can't be joined to another.

## Known limits

- Only the default task list is shown, without tasks assigned from Docs or Chat.
- Stars, repeats, deadlines, times of day, attachments and reminders aren't in Google's API.
- Google has deprecated the sign-in library this uses, in favour of
  [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/migration-to-gis).

## Files

| File | What it does |
| --- | --- |
| `index.html` | The page |
| `tasks.js` | Sign-in, and everything that talks to Google Tasks |
| `script.js` | Buttons, keys, dragging and the task count |
| `style.css` | Styles |
| `jquery.js` | jQuery 2.0.3 |

## Running it locally

    python3 -m http.server 8080

Then open http://localhost:8080/. Google sign-in only works from addresses listed
under "Authorised JavaScript origins" for the OAuth client in the
[Google Cloud project](https://console.cloud.google.com/auth/clients?project=thisismytodo):
currently `https://mytodo.github.io` and `http://localhost:8080`.

Changes pushed to `main` are published by GitHub Pages.
