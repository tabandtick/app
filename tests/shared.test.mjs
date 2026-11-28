// Tests shared lists: Alex and Sam, each in their own tab, sharing a list that's in each
// one's Google Tasks, kept matched by Tab & Tick's sync, through a local copy of the
// server (Supabase) with its real rules and Realtime. Eve, who wasn't invited, gets
// nothing. Google Tasks, and the sync's part of the server, are run by
// supabase/tests/sync_server.ts (Deno), with Google Tasks in memory.
//
//   supabase start -x studio,storage-api,imgproxy,edge-runtime,logflare,vector,mailpit,supavisor,postgres-meta
//   node tests/shared.test.mjs        (Node 22 or later, Deno, Chrome, and Docker)
// Without the local server running, it says so and stops.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// ---- The local server
let local;
try {
  local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { cwd: app, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
} catch { /* not running */ }
if (!local || !local.API_URL) { console.log('The local Supabase isn’t running: see the top of this file. Skipped.'); process.exit(0); }
const API = local.API_URL, KEY = local.PUBLISHABLE_KEY || local.ANON_KEY, SECRET = local.SECRET_KEY || local.SERVICE_ROLE_KEY;
const sql = text => execFileSync('docker', ['exec', '-i', 'supabase_db_tabandtick', 'psql', '-U', 'postgres', '-qtA', '-v', 'ON_ERROR_STOP=1'], { input: text }).toString().trim();

const PEOPLE = { alex: 'Alex', sam: 'Sam', eve: 'Eve' };
sql(`delete from public.lists; delete from auth.users where email like '%@example.com';`);
for (const [name, full] of Object.entries(PEOPLE)) {
  const r = await fetch(API + '/auth/v1/admin/users', {
    method: 'POST', headers: { apikey: SECRET, Authorization: 'Bearer ' + SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: name + '@example.com', password: 'test-password-' + name, email_confirm: true, user_metadata: { full_name: full } })
  });
  const user = await r.json();
  if (!user.id) { console.error('Could not make a test user:', user); process.exit(2); }
  // As if they'd logged in with Google, which is what lets them join lists shared with their email
  sql(`insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at) values ('g-${name}', '${user.id}', '{"sub":"g-${name}","email":"${name}@example.com","email_verified":true}', 'google', now(), now(), now());`);
}

// ---- Google Tasks in memory, and the sync, as the server runs it
const deno = spawn('deno', ['run', '-A', join(app, 'supabase/tests/sync_server.ts')], { cwd: app, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => deno.kill());
const SYNC = await new Promise((resolve, reject) => {
  let out = '';
  deno.on('error', () => reject(new Error('Deno is needed: see deno.com')));
  deno.stdout.on('data', d => { out += d; const m = out.match(/port (\d+)/); if (m) resolve('http://127.0.0.1:' + m[1] + '/'); });
});
const google = async (name, method, path, body) => (await fetch(SYNC + 'google', { method: 'POST', body: JSON.stringify({ name, method, path, body }) })).json();
const inGoogle = async (name, title) => (await fetch(SYNC + 'view?name=' + name + '&title=' + encodeURIComponent(title))).json();
for (const name of Object.keys(PEOPLE)) await google(name, 'POST', 'users/@me/lists', { title: 'My Tasks' });
const myTasks = (await inGoogle('alex', 'My Tasks')).id;
await google('alex', 'POST', `lists/${myTasks}/tasks`, { title: 'Call the plumber' });
const ids = Object.fromEntries(Object.keys(PEOPLE).map(name => [name, sql(`select id from auth.users where email = '${name}@example.com'`)]));

const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '') || 'index.html';
    const file = join(app, path);
    if (!file.startsWith(app) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/';

// ---- Chrome, and a tab for each person
const chromePath = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!chromePath) { console.error('Chrome not found: set CHROME to its path'); process.exit(2); }
const dir = mkdtempSync(join(tmpdir(), 'tabandtick-cloud-'));
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir,
  '--no-first-run', '--no-sandbox', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));
let port;
for (let i = 0; i < 300 && !port; i++) {
  try { port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await wait(200); }
}
const KEYS = { ArrowUp: 38, ArrowDown: 40, Tab: 9, Backspace: 8, Enter: 13, Escape: 27 };

async function person(name, hash = '') {
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = {}, errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled' && process.env.DEBUG) console.log('   [' + name + '] ' + m.params.args.map(a => a.value).join(' '));
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
  };
  const cdp = (method, params = {}) => new Promise(r => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  const js = async expr => {
    const m = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.result.exceptionDetails) throw new Error(name + ': ' + JSON.stringify(m.result.exceptionDetails));
    return m.result.result.value;
  };
  const key = async k => {
    const b = { key: k, code: k, windowsVirtualKeyCode: KEYS[k] };
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...b });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...b });
    await wait(40);
  };
  const type = async text => { await cdp('Input.insertText', { text }); await wait(40); };
  await cdp('Runtime.enable');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Page.enable');
  // Signed in to Google (the fake) and to the local server, as the website would be
  const signIn = `(async function() {
    API = '${SYNC}tasks/v1/';
    auth.token = function() { return '${name}'; };
    auth.hasDrive = function() { return false; };
    auth.canShare = true;
    auth.silent = function(done) { done(true); };
    loadProfile = function() {};
    tickPause = closeTime = openTime = reopenDelay = 0;
    currentAccount('${name}@example.com');
    var db = supabase.createClient('${API}', '${KEY}', { auth: { storageKey: 'test-${name}', persistSession: true } });
    var result = await db.auth.signInWithPassword({ email: '${name}@example.com', password: 'test-password-${name}' });
    if (result.error) throw new Error(result.error.message);
    cloud.db = function() { return db; };
    cloud.has = function() { return true; };
    // The server's sync, run by sync_server.ts
    cloud.syncCopy = function(email, list, done) {
      fetch('${SYNC}sync', { method: 'POST', body: JSON.stringify({ list: list, user: '${ids[name]}' }) })
        .then(function(r) { return r.ok ? r.json() : null; }).then(done, function() { done(null); });
    };
    auth.allowServer = function(email, done) {
      fetch('${SYNC}permission', { method: 'POST', body: JSON.stringify({ name: '${name}', ok: true }) }).then(function() { done(true); });
    };
    hideMessage(); $('#authorize-div').hide();
    checkAuth();
    return true;
  })()`;
  const load = async url => {
    await cdp('Page.navigate', { url });
    await wait(800);
    await js(signIn);
  };
  await load(base + 'index.html' + hash);
  await wait(1500);
  return { name, js, key, type, errors, cdp, load };
}

async function shot(p, name) {
  if (!process.env.SHOTS) return;
  const m = await p.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.env.SHOTS, name + '.png'), Buffer.from(m.result.data, 'base64'));
}

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : '\n   got  ' + JSON.stringify(got) + '\n   want ' + JSON.stringify(want)));
}
// Waits up to a few seconds for what's seen to be as wanted: Realtime takes a moment
async function eventually(label, look, want, ms = 8000) {
  let got;
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    got = await look();
    if (JSON.stringify(got) === JSON.stringify(want)) break;
  }
  check(label, got, want);
}
const seen = (p, title) => p.js(`(function() {
  var card = $('#cards .card').filter(function() { return $(this).find('.list-title').val() === ${JSON.stringify(title)}; });
  if (!card.length) return null;
  return card.find('.claire li').map(function() {
    var t = $(this).children('.todo');
    return ($(this).hasClass('subtask') ? '-' : '') + t.val() + (t.hasClass('checked') ? ' x' : '');
  }).get().join(', ');
})()`);
const sidebar = p => p.js(`$('#lists .name').map(function() { return this.textContent; }).get().join(', ')`);


const stored = () => sql(`select string_agg(title || case when status = 'completed' then ' x' else '' end, ', ' order by title) from public.tasks where deleted_at is null and list_id = '${listId}'`);
const cardOf = title => `$('#cards .card').filter(function() { return $(this).find('.list-title').val() === ${JSON.stringify(title)}; })`;
const row = (title, task) => `${cardOf(title)}.find('.todo').filter(function() { return this.value === ${JSON.stringify(task)}; })`;
let listId = '';

// ---- Alex makes a shared list: a Google Tasks list of Alex's, shared
const alex = await person('alex');
await alex.js(`$('#new-shared').click(); true`);
await wait(100);
check('the new list dialog', await alex.js(`$('#dialog p').text()`), 'Share it with anyone with a Google account.');
await alex.type('Shopping');
await alex.js(`$('#dialog form')[0].requestSubmit(); true`);
await wait(1000);
listId = sql(`select id from public.lists`);
const alexShop = (await inGoogle('alex', 'Shopping')).id;
check('it’s a list in Alex’s Google Tasks, shared on the server, shown once', [sql(`select title from public.lists`), !!alexShop, await sidebar(alex)], ['Shopping', true, 'My Tasks, Shopping']);
check('the server knows it’s Alex’s Google list', sql(`select tasklist from public.google_copies where user_id = '${ids.alex}'`), alexShop);
check('the share dialog opens, saying to send the link, and that it’s in Google Tasks', await alex.js(`[$('#share')[0].open, $('#share .share-note').text(), $('#share .copy-state span').text()]`),
  [true, 'People you add can see and change it, in Tab & Tick and in their Google Tasks. Send them the link: it opens once they log in with that Google account.',
    'It’s in your Google Tasks too, kept up to date.']);
await wait(300);
check('it lists Alex as the owner', await alex.js(`$('#share .people li').map(function() { return $(this).text(); }).get()`), ['AAlexalex@example.comOwner']);
await alex.js(`$('#share input[type=email]').focus(); true`);
await alex.type('Sam@Example.com');
await alex.js(`$('#share form')[0].requestSubmit(); true`);
await wait(600);
await eventually('Sam is invited, and shown as not having opened it yet', () => alex.js(`$('#share .people li').map(function() { return $(this).find('.name').text() + ' / ' + $(this).find('.email').text(); }).get()`),
  ['Alex / alex@example.com', 'sam@example.com / Hasn’t opened it yet']);
check('Alex is offered the link to send', await alex.js(`[$('#message span').text(), $('#message button').text()]`), ['Shared with Sam@Example.com. Send them the link so they know.', 'Copy link']);
check('the link is to the list', await alex.js(`shared.link('${alexShop}')`), base + 'index.html#list=' + listId);
await shot(alex, 'cloud-share');
await alex.js(`$('#share .close').click(); true`);

await alex.js(`${cardOf('Shopping')}.find('.new-task').click(); true`);
await alex.type('Milk'); await alex.key('Enter');
await alex.type('Bread'); await alex.key('Enter');
await alex.type('Seeded'); await alex.key('Tab');
await alex.js(`document.activeElement.blur(); true`);
await eventually('Alex’s tasks go to Google, and the server', async () => [(await inGoogle('alex', 'Shopping')).tasks, stored()], [['Milk', 'Bread', '  Seeded'], 'Bread, Milk, Seeded'], 10000);

// ---- Eve, a stranger, opens the link
const eve = await person('eve', '#list=' + listId);
check('Eve is told it isn’t shared with her', await eve.js(`$('#dialog')[0].open && $('#dialog h2').text()`), 'This list isn’t shared with eve@example.com');
check('and sees nothing of it', [await sidebar(eve), await eve.js(`shared.lists().length`), await inGoogle('eve', 'Shopping')], ['My Tasks', 0, null]);

// ---- Sam opens the link. The server hasn't Sam's permission to reach Sam's Google
// Tasks yet: the list shows from the server until Sam allows it.
await fetch(SYNC + 'permission', { method: 'POST', body: JSON.stringify({ name: 'sam', ok: false }) });
const sam = await person('sam', '#list=' + listId);
await eventually('Sam sees the list, as Alex has it, from the server', async () => [await sidebar(sam), await seen(sam, 'Shopping'), await sam.js(`shared.isCloud(${cardOf('Shopping')}[0].list)`)],
  ['My Tasks, Shopping', 'Milk, Bread, -Seeded', true]);
check('the link is gone from the address', await sam.js(`location.hash`), '');
check('Sam’s list shows Alex', await sam.js(`${cardOf('Shopping')}.find('.sharers').attr('title')`), 'Shared with Alex');
check('Sam’s menu says Leave, not Delete', await sam.js(`${cardOf('Shopping')}.find('[data-list-do=delete]').text()`), 'Leave list');
await sam.js(`shareList(${cardOf('Shopping')}[0].list); true`);
await eventually('the share dialog asks Sam’s permission for Google Tasks', () => sam.js(`[$('#share .copy-state span').text(), $('#share .copy-state button').text()]`),
  ['To keep it in your Google Tasks, Tab & Tick needs your permission.', 'Allow']);
await sam.js(`$('#share .copy-state button').click(); true`);
await eventually('Sam allows it: it’s made in Sam’s Google Tasks, and shown from there', async () => [(await inGoogle('sam', 'Shopping'))?.tasks, await sidebar(sam), await sam.js(`shared.isCloud(${cardOf('Shopping')}[0].list)`)],
  [['Milk', 'Bread', '  Seeded'], 'My Tasks, Shopping', false], 10000);
check('as the dialog says', await sam.js(`$('#share .copy-state span').text()`), 'It’s in your Google Tasks too, kept up to date.');
await sam.js(`$('#share .close').click(); true`);
await eventually('still once, with its people', async () => [await sidebar(sam), await seen(sam, 'Shopping'), await sam.js(`${cardOf('Shopping')}.find('.sharers').attr('title')`)], ['My Tasks, Shopping', 'Milk, Bread, -Seeded', 'Shared with Alex']);

// ---- Changes reach the other person in moments, and say who made them
await alex.js(`hideMessage(); true`);
await sam.js(`${row('Shopping', 'Milk')}.siblings('input[type=checkbox]').click(); true`);
await eventually('Sam ticks Milk, and Alex sees it', () => seen(alex, 'Shopping'), 'Bread, -Seeded', 10000);
await eventually('and is told who did it', () => alex.js(`$('#message span').text()`), 'Sam ticked “Milk”.');
check('it’s ticked in both Google lists', [(await inGoogle('alex', 'Shopping')).tasks, (await inGoogle('sam', 'Shopping')).tasks], [['Bread', '  Seeded', 'x Milk'], ['Bread', '  Seeded', 'x Milk']]);
await sam.js(`hideMessage(); true`);
await alex.js(`var t = ${row('Shopping', 'Bread')}; t.focus(); t.setCursorPosition(5); true`);
await alex.key('Enter');
await alex.type('Butter');
await alex.js(`document.activeElement.blur(); true`);
await eventually('Alex adds Butter, and Sam sees it', () => seen(sam, 'Shopping'), 'Bread, -Butter, -Seeded', 10000);
await eventually('Sam is told Alex added it', () => sam.js(`$('#message span').text()`), 'Alex added “Butter”.');
check('and Alex’s face is by it, but not by Sam’s own', await sam.js(`${cardOf('Shopping')}.find('.claire li').map(function() { var f = $(this).children('.changer'); return $(this).children('.todo').val() + ':' + (f.length ? f.attr('aria-label').replace(/, .*/, '') : '-'); }).get()`),
  ['Bread:-', 'Butter:Alex changed this', 'Seeded:-']);
await shot(sam, 'changer');
await alex.js(`toggleDone(${cardOf('Shopping')}); true`);
await eventually('Completed says Sam ticked Milk', () => alex.js(`${cardOf('Shopping')}.find('.done-list li .when').first().text()`), 'Completed: Today, by Sam');
check('the server has both', stored(), 'Bread, Butter, Milk x, Seeded');

// Sam is typing when Alex's change comes: Sam's typing stays
await sam.js(`var t = ${row('Shopping', 'Butter')}; t.focus(); t.setCursorPosition(6); true`);
await sam.type(' (salted)');
await alex.js(`var t = ${row('Shopping', 'Butter')}; t.focus(); t.setCursorPosition(6); true`);
await alex.key('Enter');
await alex.type('Jam');
await wait(1500);
check('while Sam types, the list isn’t redrawn under them', [await sam.js(`document.activeElement.value`)], ['Butter (salted)']);
await alex.js(`document.activeElement.blur(); true`);
await sam.js(`document.activeElement.blur(); true`);
await eventually('then both have both changes', async () => [await seen(alex, 'Shopping'), await seen(sam, 'Shopping')],
  ['Bread, -Butter (salted), -Jam, -Seeded', 'Bread, -Butter (salted), -Jam, -Seeded'], 12000);

// A deletion reaches the other person
await sam.js(`var t = ${row('Shopping', 'Jam')}; t.focus(); t.select(); true`);
await sam.key('Backspace'); await sam.key('Backspace');
await sam.js(`finishRemovals(); true`);
await eventually('Sam deletes Jam, and it goes for Alex too', () => seen(alex, 'Shopping'), 'Bread, -Butter (salted), -Seeded', 10000);

// A change made in Google's own apps shows when Tab & Tick is looked at again
const samShop = (await inGoogle('sam', 'Shopping')).id;
const breadInSam = (await google('sam', 'GET', `lists/${samShop}/tasks?showCompleted=true`)).items.find(t => t.title === 'Bread').id;
await google('sam', 'PATCH', `lists/${samShop}/tasks/${breadInSam}`, { title: 'Brown bread' });
await sam.js(`refreshAll(); true`);
await eventually('Sam renames Bread in Google Tasks: Alex sees it', () => seen(alex, 'Shopping'), 'Brown bread, -Butter (salted), -Seeded', 10000);

// Moving a task in from another Google list, and back
await alex.js(`hideMessage(); moveToList(${row('My Tasks', 'Call the plumber')}, '${alexShop}'); true`);
await eventually('a task moved in from another list reaches Sam', () => seen(sam, 'Shopping'), 'Call the plumber, Brown bread, -Butter (salted), -Seeded', 10000);
await alex.js(`$('#message button').click(); true`); // Undo
await eventually('undoing takes it back out, for Sam too', async () => [await seen(alex, 'My Tasks'), await seen(sam, 'Shopping')],
  ['Call the plumber', 'Brown bread, -Butter (salted), -Seeded'], 10000);

// Renaming
await alex.js(`${cardOf('Shopping')}.find('.list-title').val('Food shop').trigger('change'); true`);
await eventually('a new name reaches the server, Sam, and Sam’s Google Tasks', async () => [sql(`select title from public.lists`), await sidebar(sam), !!(await inGoogle('sam', 'Food shop'))],
  ['Food shop', 'My Tasks, Food shop', true], 10000);

// Who's in it, now Sam has opened it
await alex.js(`shareList('${alexShop}'); true`);
await wait(500);
check('Alex sees Sam has joined', await alex.js(`$('#share .people li').map(function() { return $(this).find('.name').text() + ' / ' + $(this).find('.email').text(); }).get()`),
  ['Alex / alex@example.com', 'Sam / sam@example.com']);
await alex.js(`$('#share .close').click(); true`);

// Sharing a Google list Alex already has: it becomes the shared list, with nothing copied
await alex.js(`shareList('${myTasks}'); true`);
check('not the first list, which Google keeps', await alex.js(`$('#message span').text()`), 'Google keeps your first list just for you. Make a new list to share.');
const garden = await google('alex', 'POST', 'users/@me/lists', { title: 'Garden' });
await google('alex', 'POST', `lists/${garden.id}/tasks`, { title: 'Mow the lawn' });
await alex.js(`refreshAll(); true`);
await eventually('(Alex sees Garden)', () => sidebar(alex), 'My Tasks, Food shop, Garden');
await alex.js(`shareList('${garden.id}'); true`);
await eventually('sharing Garden shares that list, with its task', async () => [await sidebar(alex), await alex.js(`${cardOf('Garden')}.hasClass('shared')`), await alex.js(`$('#share')[0].open`),
  sql(`select string_agg(t.title, ',') from public.tasks t join public.lists l on l.id = t.list_id where l.title = 'Garden'`)],
  ['My Tasks, Food shop, Garden', true, true, 'Mow the lawn'], 10000);
await alex.js(`$('#share')[0].close(); true`);

// After a refresh, the lists are found again, and still live
await sam.load(base + 'index.html');
await wait(1500);
check('after a refresh, Sam’s shared list is found again', [await sidebar(sam), await seen(sam, 'Food shop')], ['My Tasks, Food shop', 'Brown bread, -Butter (salted), -Seeded']);
await alex.js(`${row('Food shop', 'Seeded')}.siblings('input[type=checkbox]').click(); true`);
await eventually('and changes still arrive (a ticked subtask stays under its task, as in Google Tasks)', () => seen(sam, 'Food shop'), 'Brown bread, -Butter (salted), -Seeded x', 10000);

// Sam deletes the list in Google Tasks: it shows from the server, and can be put back
await google('sam', 'DELETE', `users/@me/lists/${samShop}`);
await sam.js(`refreshAll(); true`);
await eventually('Sam deletes it in Google Tasks: it’s still in Tab & Tick, from the server', async () => [await sidebar(sam), await sam.js(`shared.isCloud((${cardOf('Food shop')}[0] || {}).list)`)],
  ['My Tasks, Food shop', true], 10000);
await sam.js(`${row('Food shop', 'Butter (salted)')}.siblings('input[type=checkbox]').click(); true`);
await eventually('changes there still reach Alex', () => seen(alex, 'Food shop'), 'Brown bread, -Butter (salted) x, -Seeded x', 10000);
await sam.js(`shareList(${cardOf('Food shop')}[0].list); true`);
await eventually('the share dialog offers to put it back', () => sam.js(`[$('#share .copy-state span').text(), $('#share .copy-state button').text()]`), ['It’s not in your Google Tasks.', 'Add it back']);
await sam.js(`$('#share .copy-state button').click(); true`);
await eventually('and it’s back in Sam’s Google Tasks', async () => [(await inGoogle('sam', 'Food shop'))?.tasks, await sam.js(`shared.isCloud((${cardOf('Food shop')}[0] || {}).list)`)],
  [['Brown bread', 'x Butter (salted)', 'x Milk', 'x Seeded'], false], 10000);
await sam.js(`$('#share')[0].close(); true`);

// Sam leaves; Alex deletes
await sam.js(`shared.remove(${cardOf('Food shop')}[0].list); true`);
await wait(100);
check('leaving asks first', await sam.js(`[$('#dialog h2').text(), $('#dialog p').text()]`), ['Leave “Food shop”?', 'It’s removed from your lists and your Google Tasks. Whoever shared it can share it with you again.']);
await sam.js(`$('#dialog form')[0].requestSubmit(); true`);
await eventually('Sam leaves the list, and it goes from Sam’s Google Tasks', async () => [sql(`select string_agg(email, ',') from public.list_members where list_id = '${listId}'`), await sidebar(sam), await inGoogle('sam', 'Food shop')],
  ['alex@example.com', 'My Tasks', null]);
await alex.js(`shared.remove('${alexShop}'); true`);
await wait(100);
check('deleting says it’s for everyone', await alex.js(`$('#dialog p').text()`), 'It’s deleted for everyone it’s shared with, from Tab & Tick and their Google Tasks, and can’t be got back.');
await alex.js(`$('#dialog form')[0].requestSubmit(); true`);
await eventually('Alex deletes it, with its tasks, from the server and Google Tasks', async () => [sql(`select count(*) from public.tasks where list_id = '${listId}'`), await sidebar(alex), await inGoogle('alex', 'Food shop')],
  ['0', 'My Tasks, Garden', null]);

check('no errors in any page', [...alex.errors, ...sam.errors, ...eve.errors], []);
sql(`delete from public.lists; delete from auth.users where email like '%@example.com';`);
console.log(failures ? failures + ' failed' : 'all passed');
chrome.kill();
deno.kill();
server.close();
