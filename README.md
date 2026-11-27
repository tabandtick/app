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
- **On a phone or tablet,** hold a task, or choose **Select** in its menu, to pick it; tap others
  to add them, then **Tick** or **Delete** them from the bar at the bottom.
- **Search** at the top, or **/**, shows only the tasks whose title or notes have every word.
  Moving and indenting wait until it's cleared.
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

**Shared lists** (on the website, for now) can be shared with anyone with a Google
account, to see and change together, such as a household's shopping. Google Tasks can't
share lists, so a shared list is kept in a file in the Google Drive of whoever made it,
shared with the others as Drive shares any file. **Create shared list** in the sidebar
makes one, and **Share** on it adds people by email: Drive emails them a link, which
opens it here. **Share** on a Google Tasks list offers a shared copy of it. Changes are
saved at once and others' changes appear within a few seconds; if two people change
the same task at once, the later change wins. Shared lists aren't in Google Tasks
itself, so they don't show in Gmail, Calendar or Google's Tasks app.

**More than one Google account** (on the website): the account menu lists the others
under yours, and **Add another account** adds one. Switching is at once for an account
used in this tab within the hour, and otherwise Google's window opens and closes by
itself. Each account keeps its own hidden lists. **Log out** logs out of the one in use
and goes to the next.

**?** or **Cmd/Ctrl+/** shows all the keyboard shortcuts, as does the account menu.

**Cmd/Ctrl+Z** undoes completing, moving, indenting and splitting, and deleting and
joining within 7 seconds. If you have typed since, it undoes typing instead. Google is only told
to delete anything once that time is up, or when the page closes.

## Known limits

- Stars, repeats, deadlines, times of day, attachments and reminders aren't in
  Google's API. Tasks assigned from Docs or Chat aren't shown.
- A task with subtasks can't be moved to another list.
- On the website, Google's sign-in lasts an hour, and Google gives a website no way to
  renew it without a click. In its last five minutes, or once it has run out, your next
  click or key renews it: a Google window opens and closes by itself. It's kept in the
  browser, so closing the tab doesn't log you out. The extension stays signed in, as
  Chrome looks after it.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | The page |
| `auth.js` | Signing in, as a website or as an extension |
| `tasks.js` | Lists, tasks, and everything that talks to Google Tasks |
| `shared.js` | Shared lists, kept in Google Drive: answers for them as Google Tasks would |
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
    node tests/shared.test.mjs

They run the app in headless Chrome (Node 22 or later), pressing keys and clicking as a
person would. The first is against a small fake of Google Tasks that refuses what the
real one refuses; the second has two people, each in their own tab, sharing a list in
a small fake of Google Drive. `SHOTS=folder` saves pictures of its screens. GitHub runs
both on every push, and before publishing.

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
origins" for the OAuth client in `auth.js`. Shared lists also need, in the same Google
Cloud project, the Google Drive API and the Google Picker API turned on, the
`drive.file` scope on the consent screen, and a browser API key, limited to those
addresses and the Picker API, as `PICKER_KEY` in `shared.js`. Pushes to `main` are published by
GitHub Pages.

## Copyright

Copyright © 2026 Tab & Tick. All rights reserved. The code is published so that anyone can
see what the app does; it isn't licensed for reuse. The add-task icon is from Material
Symbols, under its own licence in `icons/LICENSE-material-symbols.txt`.
