# Tab & Tick

A fast to-do list that works with Google Tasks. It runs as a website and as a
Chrome extension that opens in every new tab, from the same files. There is no
server or build step. Not made or endorsed by Google.

## Using it

- **Add a task** adds one at the top. It is saved once it has a title.
- **Typing** in a row edits its title, and saves shortly after you stop.
- **The circle** completes a task, or reopens it. A completed subtask stays under its
  task until that is completed too, and reopening it reopens that.
- **Editing a task** shows its details under it: notes, and **Today**, **Tomorrow** or
  any date as its due date. Elsewhere a line shows the date and the start of the notes.
- **The dots on the right** of a row open its menu: notes and due date, subtasks,
  moving and deleting.
- **Delete** in the menu deletes a task and any subtasks, and moves on to the next.
- **Cmd/Ctrl+Enter** ticks a task, or reopens it, and moves on to the next. With
  several tasks picked, it ticks them all.
- **Pasting several lines** makes a task of each.
- **Coming back** to the tab after a while shows any changes made elsewhere.
- **Enter** splits a row in two. **Backspace** at the start joins it to the row
  above, and **Delete** at the end joins the next one to it.
- **Drag the handle** to move a task: right to make it a subtask, left to move out.
- **Tab** makes a task a subtask, along with any subtasks of its own, and **Shift+Tab**
  moves it out, taking the subtasks below it as its own.
- **Shift+up/down** or **Shift+click** picks several tasks in a row, and **Cmd/Ctrl+click**
  adds or takes away one at a time. Then **Delete** or **Backspace** deletes them,
  **Tab**, **Shift+Tab** and **Alt+up/down** move them, and **Cmd/Ctrl+C** copies their
  titles. **Escape**, an arrow key or a click goes back to typing.
- **Alt+up/down** moves a task. **Cmd/Ctrl+]** and **[** indent it from anywhere.
- **Completed** tasks load as you scroll.
- **Lists** appear side by side. Untick one in the sidebar to hide it, and the chevron by
  Lists folds them away. **☰** hides the sidebar. The menu on a
  card renames, hides or deletes it, and a task's menu, or dragging, moves it to
  another list.

**?** or **Cmd/Ctrl+/** shows all the keyboard shortcuts, as does the account menu.

**Cmd/Ctrl+Z** undoes completing, moving, indenting and splitting, and deleting and
joining within 7 seconds. If you have typed since, it undoes typing instead. Google is only told
to delete anything once that time is up, or when the page closes.

## Known limits

- Stars, repeats, deadlines, times of day, attachments and reminders aren't in
  Google's API. Tasks assigned from Docs or Chat aren't shown.
- A task with subtasks can't be moved to another list.
- On the website, Google's sign-in lasts an hour. In its last five minutes, your next
  click or key renews it: a Google window may open and close by itself. Left alone for
  longer, or in a new browser tab, it asks you to log in. The extension doesn't.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | The page |
| `auth.js` | Signing in, as a website or as an extension |
| `tasks.js` | Lists, tasks, and everything that talks to Google |
| `script.js` | Buttons, keys, dragging and counts |
| `manifest.json`, `icons/` | The Chrome extension. The add-task icon is from Material Symbols, under the Apache License 2.0 in `icons/LICENSE-material-symbols.txt` |
| `jquery.js` | jQuery 2.0.3 |

## The extension

Published on the Chrome Web Store as
[Tab & Tick](https://chromewebstore.google.com/detail/tab-tick/amidicalcieolbecimlogomhnokopigp).
The store package is made by `tools/build-store.py`. To work on it locally:

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**
   and pick this folder.
2. `oauth2.client_id` in `manifest.json` must be an OAuth client of type **Chrome
   Extension** whose item ID matches the extension's. The `key` in the manifest
   fixes that ID as `jaanjobpenabcgjkjehbplfcgadikbbm`.

After changing a file, press reload on `chrome://extensions`.

## Tests

    node tests/app.test.mjs

It runs the app in headless Chrome (Node 22 or later), pressing keys and clicking as a
person would, against a small fake of Google Tasks that refuses what the real one
refuses. GitHub runs it on every push, and before publishing.

## Releasing

Change `version` in `manifest.json`, commit, then push a tag to match:

    git tag v1.1.5 && git push origin main v1.1.5

`.github/workflows/publish.yml` then builds the package, uploads it to the Chrome Web
Store and submits it for review. It needs four repository secrets, listed at the top of
that file. Changes to the store listing or privacy answers are still made in the
dashboard, before tagging.

## The website

    python3 -m http.server 8080

Google sign-in only works from addresses listed under "Authorised JavaScript
origins" for the OAuth client in `auth.js`. Pushes to `main` are published by
GitHub Pages.
