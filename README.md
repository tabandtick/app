# MyTo.Do

A simple to-do list for Google Tasks: https://mytodo.github.io/MyTo.Do/

It is a static page with no server or build step. It signs in with Google and
works on your default task list.

## Using it

- **New Task** adds a task at the top. It is saved once it has a title.
- **Typing** in a row edits its title, and saves shortly after you stop.
- **The tick box** completes or reopens a task.
- **Delete Task** deletes the task you last clicked, marked with a blue bar.
- **Enter** splits a row into two tasks.
- **Backspace** at the start of a row joins it to the one above.
- **Delete** at the end of a row joins the next one to it.
- **Up and down arrows** move between rows.

Deleting and joining can be undone for 7 seconds. Google is only told to delete
anything once that time is up, or when the page closes.

## Known limits

- Only the default task list is shown, and subtasks appear as ordinary tasks.
- A task made with Enter moves to the top after a refresh.
- There is no log out button.
- Google has deprecated the sign-in library this uses, in favour of
  [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/migration-to-gis).

## Files

| File | What it does |
| --- | --- |
| `index.html` | The page |
| `tasks.js` | Sign-in, and everything that talks to Google Tasks |
| `script.js` | Buttons, keys and the task count |
| `style.css` | Styles |
| `jquery.js` | jQuery 2.0.3 |

## Running it locally

    python3 -m http.server 8080

Then open http://localhost:8080/. Google sign-in only works from addresses listed
under "Authorised JavaScript origins" for the OAuth client in the
[Google Cloud project](https://console.cloud.google.com/auth/clients?project=thisismytodo):
currently `https://mytodo.github.io` and `http://localhost:8080`.

Changes pushed to `main` are published by GitHub Pages.
