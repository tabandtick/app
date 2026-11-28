// Tests shared lists kept on Tab & Tick's server: Alex and Sam, each in their own tab,
// sharing a list through a local copy of the server (Supabase), with its real rules
// and Realtime. Eve, who wasn't invited, gets nothing. Google Tasks is a small fake.
//
//   supabase start -x studio,storage-api,imgproxy,edge-runtime,logflare,vector,mailpit,supavisor,postgres-meta
//   node tests/cloud.test.mjs        (Node 22 or later, Chrome, and Docker)
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

// ---- A fake of Google Tasks, with a list each
const googleTasks = { alex: [{ id: 'g1', title: 'Call the plumber', status: 'needsAction', position: '00000000000000000001' }], sam: [], eve: [] };
let made = 0;
function fake(req, res, path, body) {
  const user = (req.headers.authorization || '').replace('Bearer ', '');
  const url = new URL(path, 'http://x'), q = url.searchParams, parts = url.pathname.split('/').filter(Boolean);
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
  const tasks = googleTasks[user];
  if (!tasks) return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
  const rest = parts.slice(2).join('/');
  if (rest === 'users/@me/lists') return json(200, { items: [{ id: 'g1', title: 'My Tasks' }] });
  if (rest === 'users/@me/lists/@default') return json(200, { id: 'g1' });
  const m = rest.match(/^lists\/g1\/tasks(?:\/([^/]+))?$/);
  const task = m && m[1] && tasks.find(t => t.id === m[1]);
  if (!m || (m[1] && !task)) return json(404, { error: { code: 404, message: 'Not found' } });
  if (req.method === 'GET' && !m[1]) return json(200, { items: tasks.filter(t => q.get('showCompleted') !== 'false' || t.status !== 'completed') });
  if (req.method === 'GET') return json(200, task);
  if (req.method === 'POST') { const t = { id: 'g' + (++made + 100), position: '0', status: 'needsAction', ...JSON.parse(body || '{}') }; tasks.unshift(t); return json(200, t); }
  if (req.method === 'PATCH') { Object.assign(task, JSON.parse(body || '{}')); return json(200, task); }
  if (req.method === 'DELETE') { tasks.splice(tasks.indexOf(task), 1); return json(204); }
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url.startsWith('/fake/')) return fake(req, res, req.url.slice(5), body);
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
    API = '${base}fake/tasks/v1/';
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
async function eventually(label, look, want, ms = 5000) {
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
const stored = () => sql(`select string_agg(title || case when status = 'completed' then ' x' else '' end, ', ' order by title) from public.tasks where deleted_at is null`);

// ---- Alex makes a shared list: on the server, with no Drive
const alex = await person('alex');
await alex.js(`$('#new-shared').click(); true`);
await wait(100);
check('the new list dialog doesn’t mention Drive', await alex.js(`$('#dialog p').text()`), 'Share it with anyone with a Google account.');
await alex.type('Shopping');
await alex.js(`$('#dialog form')[0].requestSubmit(); true`);
await wait(800);
const listId = sql(`select id from public.lists`);
check('the list is made on the server, and shown', [sql(`select title from public.lists`), await sidebar(alex)], ['Shopping', 'My Tasks, Shopping']);
check('the share dialog opens, saying to send the link', await alex.js(`[$('#share')[0].open, $('#share .share-note').text()]`),
  [true, 'People you add can see and change this list in Tab & Tick. Send them the link: it opens once they log in with that Google account.']);
await wait(300);
check('it lists Alex as the owner', await alex.js(`$('#share .people li').map(function() { return $(this).text(); }).get()`), ['AAlexalex@example.comOwner']);
await alex.js(`$('#share input[type=email]').focus(); true`);
await alex.type('Sam@Example.com');
await alex.js(`$('#share form')[0].requestSubmit(); true`);
await wait(600);
check('Sam is invited, and shown as not having opened it yet', await alex.js(`$('#share .people li').map(function() { return $(this).find('.name').text() + ' / ' + $(this).find('.email').text(); }).get()`),
  ['Alex / alex@example.com', 'sam@example.com / Hasn’t opened it yet']);
check('Alex is offered the link to send', await alex.js(`[$('#message span').text(), $('#message button').text()]`), ['Shared with Sam@Example.com. Send them the link so they know.', 'Copy link']);
check('the link is to the list', await alex.js(`shared.link('cloud:${listId}')`), base + 'index.html#list=' + listId);
await shot(alex, 'cloud-share');
await alex.js(`$('#share .close').click(); true`);

await alex.js(`$('#cards .card.shared .new-task').click(); true`);
await alex.type('Milk'); await alex.key('Enter');
await alex.type('Bread'); await alex.key('Enter');
await alex.type('Seeded'); await alex.key('Tab');
await wait(800);
check('Alex’s tasks are on the server', stored(), 'Bread, Milk, Seeded');

// ---- Eve, a stranger, opens the link
const eve = await person('eve', '#list=' + listId);
check('Eve is told it isn’t shared with her', await eve.js(`$('#dialog')[0].open && $('#dialog h2').text()`), 'This list isn’t shared with eve@example.com');
check('and sees nothing of it', [await sidebar(eve), await eve.js(`cloudLists.lists().length`)], ['My Tasks', 0]);

// ---- Sam opens the link: Sam's in, having been invited
const sam = await person('sam', '#list=' + listId);
check('Sam sees the list, as Alex has it', [await sidebar(sam), await seen(sam, 'Shopping')], ['My Tasks, Shopping', 'Milk, Bread, -Seeded']);
check('the link is gone from the address', await sam.js(`location.hash`), '');
check('Sam’s list shows Alex', await sam.js(`$('.card.shared .sharers').attr('title')`), 'Shared with Alex');
check('Sam’s menu says Leave, not Delete', await sam.js(`$('.card.shared [data-list-do=delete]').text()`), 'Leave list');

// ---- Changes reach the other person as they're made, without looking
await sam.js(`$('.card.shared .todo').filter(function() { return this.value === 'Milk'; }).siblings('input[type=checkbox]').click(); true`);
await eventually('Sam ticks Milk, and Alex sees it at once', () => seen(alex, 'Shopping'), 'Bread, -Seeded');
await alex.js(`var t = $('.card.shared .todo').filter(function() { return this.value === 'Bread'; }); t.focus(); t.setCursorPosition(5); true`);
await alex.key('Enter');
await alex.type('Butter');
await alex.js(`document.activeElement.blur(); true`);
await eventually('Alex adds Butter, and Sam sees it at once', () => seen(sam, 'Shopping'), 'Bread, -Butter, -Seeded');
check('the server has both', stored(), 'Bread, Butter, Milk x, Seeded');

// Sam is typing when Alex's change comes: Sam's typing stays
await sam.js(`var t = $('.card.shared .todo').filter(function() { return this.value === 'Butter'; }); t.focus(); t.setCursorPosition(6); true`);
await sam.type(' (salted)');
await alex.js(`var t = $('.card.shared .todo').filter(function() { return this.value === 'Butter'; }); t.focus(); t.setCursorPosition(6); true`);
await alex.key('Enter');
await alex.type('Jam');
await wait(600);
check('while Sam types, the list isn’t redrawn under them', [await sam.js(`document.activeElement.value`)], ['Butter (salted)']);
await alex.js(`document.activeElement.blur(); true`);
await eventually('then both have both changes', async () => [await seen(alex, 'Shopping'), await seen(sam, 'Shopping')],
  ['Bread, -Butter (salted), -Jam, -Seeded', 'Bread, -Butter (salted), -Jam, -Seeded'], 8000);
check('and Sam is still typing where they were', await sam.js(`[document.activeElement.value, document.activeElement.selectionStart]`), ['Butter (salted)', 15]);

// A deletion reaches the other person
await sam.js(`document.activeElement.blur(); var t = $('.card.shared .todo').filter(function() { return this.value === 'Jam'; }); t.focus(); t.select(); true`);
await sam.key('Backspace'); await sam.key('Backspace');
await sam.js(`finishRemovals(); true`);
await eventually('Sam deletes Jam, and it goes for Alex too', () => seen(alex, 'Shopping'), 'Bread, -Butter (salted), -Seeded');
check('marked deleted on the server, not removed', sql(`select count(*) from public.tasks where deleted_at is not null`), '1');

// Moving a task in from Google Tasks
await alex.js(`moveToList($('.card:not(.shared) .todo').filter(function() { return this.value === 'Call the plumber'; }), 'cloud:${listId}'); true`);
await eventually('a task moved in from Google Tasks leaves it, and Sam sees it', async () => [googleTasks.alex.map(t => t.title), await seen(sam, 'Shopping')],
  [[], 'Call the plumber, Bread, -Butter (salted), -Seeded']);
await alex.js(`$('#message button').click(); true`); // Undo
await eventually('undoing puts it back in Google Tasks, and Sam sees it go', async () => [googleTasks.alex.map(t => t.title), await seen(sam, 'Shopping')],
  [['Call the plumber'], 'Bread, -Butter (salted), -Seeded']);

// Renaming
await alex.js(`$('.card.shared .list-title').val('Food shop').trigger('change'); true`);
await eventually('a new name reaches the server and Sam', async () => [sql(`select title from public.lists`), await sidebar(sam)], ['Food shop', 'My Tasks, Food shop']);

// Who's in it, now Sam has opened it
await alex.js(`shareList('cloud:${listId}'); true`);
await wait(500);
check('Alex sees Sam has joined', await alex.js(`$('#share .people li').map(function() { return $(this).find('.name').text() + ' / ' + $(this).find('.email').text(); }).get()`),
  ['Alex / alex@example.com', 'Sam / sam@example.com']);
await alex.js(`$('#share .close').click(); true`);

// A Google Tasks list can be shared as a copy, on the server
await alex.js(`shareList('g1'); true`);
check('sharing a Google Tasks list offers a shared copy, not in Drive', await alex.js(`$('#dialog p').text()`), 'Google Tasks can’t share lists, so this makes a shared copy of it, with its open tasks. The original stays in Google Tasks.');
await alex.js(`$('#dialog form')[0].requestSubmit(); true`);
await wait(1000);
check('which is made, with its tasks', [await sidebar(alex), sql(`select count(*) from public.lists`), await alex.js(`$('.card.shared').last().find('.claire .todo').map(function() { return this.value; }).get().join()`)],
  ['My Tasks, Food shop, My Tasks', '2', 'Call the plumber']);
await alex.js(`$('#share')[0].close(); true`);

// After a refresh, the lists are found again, and still live
await sam.load(base + 'index.html');
await wait(1500);
check('after a refresh, Sam’s shared list is found again', [await sidebar(sam), await seen(sam, 'Food shop')], ['My Tasks, Food shop', 'Bread, -Butter (salted), -Seeded']);
await alex.js(`var t = $('.card.shared .todo').filter(function() { return this.value === 'Seeded'; }); t.siblings('input[type=checkbox]').click(); true`);
await eventually('and changes still arrive (a ticked subtask stays under its task, as in Google Tasks)', () => seen(sam, 'Food shop'), 'Bread, -Butter (salted), -Seeded x');

// Sam leaves; Alex deletes
await sam.js(`shared.remove('cloud:${listId}'); true`);
await wait(100);
check('leaving asks first', await sam.js(`$('#dialog h2').text()`), 'Leave “Food shop”?');
await sam.js(`$('#dialog form')[0].requestSubmit(); true`);
await wait(600);
check('Sam leaves the list', [sql(`select string_agg(email, ',') from public.list_members where list_id = '${listId}'`), await sidebar(sam)], ['alex@example.com', 'My Tasks']);
await alex.js(`shared.remove('cloud:${listId}'); true`);
await wait(100);
check('deleting says it’s for everyone', await alex.js(`$('#dialog p').text()`), 'It’s deleted for everyone it’s shared with, and can’t be got back.');
await alex.js(`$('#dialog form')[0].requestSubmit(); true`);
await wait(600);
check('Alex deletes it, with its tasks', [sql(`select count(*) from public.tasks where list_id = '${listId}'`), await sidebar(alex)], ['0', 'My Tasks, My Tasks']);

check('no errors in any page', [...alex.errors, ...sam.errors, ...eve.errors], []);
sql(`delete from public.lists; delete from auth.users where email like '%@example.com';`);
console.log(failures ? failures + ' failed' : 'all passed');
chrome.kill();
server.close();
process.exit(failures ? 1 : 0);
