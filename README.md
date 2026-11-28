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
- **A date at the end of a title** becomes its due date when you leave it: "Pay rent
  fri", "Dentist tomorrow", "Birthday on 5 dec", "Taxes 31/1", "in 2 weeks", "next
  week". Undo, or Cmd/Ctrl+Z, puts the words back, and they're then left alone.
- **Coming back** to the tab after a while shows any changes made elsewhere.
- **Without a connection,** the website still opens (`sw.js` keeps its files), says
  you're offline, and saves your changes when you're back.
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

**Shared lists** can be shared with anyone with a Google
account, to see and change together, such as a household's shopping. Google Tasks can't
share a list, so each person has it as a normal list in their own Google Tasks, and Tab
& Tick's server keeps them matched. So a shared list is in Gmail, Calendar, Google's
Tasks app and "Hey Google" too. **Share** on any list but your first shares that list;
**Create shared list** in the sidebar makes a new one. You add people by their Google
email and send them the link; the list appears in their Google Tasks once they open it.
Changes made in Tab & Tick reach the others in moments, and those made in Google's own
apps within about a minute. When two people change the same task at once, both changes
are kept unless they changed the same thing, when the later wins; an edit beats a
delete. Until the server has your permission to reach your Google Tasks (the share
dialog asks), or if you delete your copy there, Tab & Tick shows the list from the
server instead.

**More than one Google account:** the account menu lists the others
under yours, and **Add another account** adds one. Switching is at once for an account
used in this tab within the hour, and otherwise Google's window opens and closes by
itself. Each account keeps its own hidden lists. **Log out** logs out of the one in use
and goes to the next.

In the extension, Chrome's own account signs in through Chrome and stays signed in;
others sign in through Google's page for extensions, and renew by themselves while
they're signed in to Google in Chrome. For shared lists, it gets its own session with
Tab & Tick's server from Google's page, quietly, and gives the server permission to keep
them in your Google Tasks when you click **Allow**.

**?** or **Cmd/Ctrl+/** shows all the keyboard shortcuts, as does the account menu.

**Cmd/Ctrl+Z** undoes completing, moving, indenting and splitting, and deleting and
joining within 7 seconds. If you have typed since, it undoes typing instead. Google is only told
to delete anything once that time is up, or when the page closes.

## Known limits

- Stars, repeats, deadlines, times of day, attachments and reminders aren't in
  Google's API. Tasks assigned from Docs or Chat aren't shown.
- A task with subtasks can't be moved to another list.
- On the website, Google's sign-in lasts an hour. Tab & Tick's server (below) keeps
  you logged in by getting a fresh one before each hour is up. Without it, your next
  click or key near the end of the hour renews it in a Google window that closes by
  itself. The extension stays signed in, as Chrome looks after it.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | The page |
| `auth.js` | Signing in, as a website or as an extension |
| `tasks.js` | Lists, tasks, and everything that talks to Google Tasks |
| `sw.js` | Keeps the website's own files, so it opens offline |
| `cloud.js`, `supabase.js` | The link to Tab & Tick's server, and Supabase's library (2.49.4) |
| `supabase/` | The server: Google sign-in tokens and the functions that use them, and shared lists, with their rules and tests |
| `shared.js` | Shared lists: which of your Google lists are shared, telling the server of changes, and showing a list from the server (answering as Google Tasks would) until it's in your Google Tasks |
| `script.js` | Buttons, keys, dragging and counts |
| `manifest.json`, `icons/` | The Chrome extension. The add-task icon is from Material Symbols, under the Apache License 2.0 in `icons/LICENSE-material-symbols.txt` |
| `jquery.js` | jQuery 3.7.1 |

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
    deno test -A supabase/tests/copies.test.ts

The first two run the app in headless Chrome (Node 22 or later), pressing keys and
clicking as a person would. The first is against a small fake of Google Tasks that
refuses what the real one refuses; the second has two people, each in their own tab,
sharing a list through a local copy of Tab & Tick's server and the sync, with Google
Tasks in memory (`supabase/tests/sync_server.ts`, Deno), and a stranger who must see
none of it. The third tests the sync on its own, against Google Tasks in memory
(`supabase/tests/fake_google.ts`, which behaves as Google was seen to). The second and
third need Docker and the local server (see their first lines), and Deno.
`supabase/tests/shared_lists.sql` checks the server's rules on their own.
`SHOTS=folder` saves pictures of the screens. GitHub runs them all on every push.

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
origins" for the OAuth client in `auth.js`. Pushes to `main` are published by GitHub
Pages.

## The server

Tab & Tick's server is a Supabase project (`tabandtick`, London) that keeps the website
signed in. Logging in gets a one-time code from Google's window; the function
`google-sign-in` swaps it for Google's tokens and keeps the refresh token, encrypted
(AES-GCM, with `TOKEN_KEY`, a function secret). `google-token` returns a fresh
hour-long Google token for a signed-in Supabase session, and `google-sign-out` forgets
it unless you're in a shared list. Only tokens limited to Tab & Tick's own scopes are
kept, and ones unused for six months are deleted daily.

It also keeps shared lists: their people, and a record of each list in the middle,
which is how `google-copies` keeps everyone's Google list for it matched
(`supabase/functions/_shared/copies.ts`). It reads and changes those lists and no
others. It runs when someone changes a shared list in Tab & Tick, when the database
sees a change (a trigger, through `pg_net`), and every minute (`pg_cron`), for changes
made in Google's own apps, which Google doesn't announce.

    supabase db push --remote                 # the tables, in supabase/migrations
    supabase functions deploy google-copies   # each function in supabase/functions

Function secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (the Website sign-in
client's), `TOKEN_KEY`. Google is turned on as a sign-in provider in Supabase with the
same client ID. In the database's vault, `project_url` is the project's address, for the
trigger and the cron to reach `google-copies`; the key they send is made by the
migration.

## Copyright

Copyright © 2026 Tab & Tick. All rights reserved. The code is published so that anyone can
see what the app does; it isn't licensed for reuse. The add-task icon is from Material
Symbols, under its own licence in `icons/LICENSE-material-symbols.txt`.
