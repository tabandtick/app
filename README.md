# Tab & Tick

A fast to-do list that works with Google Tasks. It runs as a website and as a
Chrome extension that opens in every new tab, from the same files. There is no
server or build step. Not made or endorsed by Google.

## Using it

- **Add a task** adds one at the top. It is saved once it has a title.
- **Typing** in a row edits its title, and saves shortly after you stop.
- **The circle** completes a task, or reopens it. A completed subtask stays under its
  task until that is completed too.
- **The dots on the right** of a row open its menu: notes and due date, subtasks,
  moving and deleting.
- **Delete** in the menu deletes a task and any subtasks, and moves on to the next.
- **Enter** splits a row in two. **Backspace** at the start joins it to the row
  above, and **Delete** at the end joins the next one to it.
- **Drag the handle** to move a task: right to make it a subtask, left to move out.
- **Tab** at the start of a task makes it a subtask, and **Shift+Tab** moves it out.
- **Alt+up/down** moves a task. **Cmd/Ctrl+]** and **[** indent it from anywhere.
- **Lists** are in the sidebar. Click a list's name above its tasks to rename it.

Completing, deleting and joining can be undone for 7 seconds. Google is only told
to delete anything once that time is up, or when the page closes.

## Known limits

- Stars, repeats, deadlines, times of day, attachments and reminders aren't in
  Google's API. Tasks assigned from Docs or Chat aren't shown.
- Lists can't be deleted, and tasks can't be moved between lists.
- The website asks you to log in about once an hour, and in each new browser tab.
  The extension doesn't.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | The page |
| `auth.js` | Signing in, as a website or as an extension |
| `tasks.js` | Lists, tasks, and everything that talks to Google |
| `script.js` | Buttons, keys, dragging and counts |
| `manifest.json`, `icons/` | The Chrome extension |
| `jquery.js` | jQuery 2.0.3 |

## The extension

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**
   and pick this folder.
2. `oauth2.client_id` in `manifest.json` must be an OAuth client of type **Chrome
   Extension** whose item ID matches the extension's. The `key` in the manifest
   fixes that ID as `jaanjobpenabcgjkjehbplfcgadikbbm`.

After changing a file, press reload on `chrome://extensions`.

## The website

    python3 -m http.server 8080

Google sign-in only works from addresses listed under "Authorised JavaScript
origins" for the OAuth client in `auth.js`. Pushes to `main` are published by
GitHub Pages.
