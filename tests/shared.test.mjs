// Tests shared lists: two people, each in their own tab, sharing one list kept in a
// small fake of Google Drive, which this serves along with the app and a fake of
// Google Tasks. Like Drive's drive.file access, each person can only open the files
// they made, or picked.
//
//   node tests/shared.test.mjs        (Node 22 or later, and Chrome)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// ---- The fakes. A person's token is their name.
const TYPE = 'application/vnd.tabandtick.list+json';
const files = {}; // id: { id, name, mimeType, version, content, trashed, owner, perms: [{ id, role, emailAddress, type }] }
const picked = { alex: new Set(), sam: new Set() }; // what each may open: made or picked
const googleTasks = { alex: [{ id: 'g1', title: 'Call the plumber', status: 'needsAction', position: '00000000000000000001' }], sam: [] };
let made = 0;
const requests = [];

function meta(f, user) {
  return { id: f.id, name: f.name, version: String(f.version), ownedByMe: f.owner === user, capabilities: { canShare: true } };
}
function canOpen(f, user) {
  return f && !f.trashed && picked[user].has(f.id) && f.perms.some(p => p.id === 'p-' + user);
}
function fake(req, res, path, body) {
  const user = (req.headers.authorization || '').replace('Bearer ', '');
  const url = new URL(path, 'http://x');
  const q = url.searchParams, parts = url.pathname.split('/').filter(Boolean);
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
  const fail = (status, message) => json(status, { error: { code: status, message } });
  requests.push(req.method + ' ' + user + ' ' + url.pathname);
  if (!picked[user]) return fail(401, 'Invalid Credentials');

  // Google Tasks, just enough for a list of your own
  if (parts[0] === 'tasks') {
    const rest = parts.slice(2).join('/');
    if (rest === 'users/@me/lists') return json(200, { items: [{ id: 'g1', title: 'My Tasks' }] });
    if (rest === 'users/@me/lists/@default') return json(200, { id: 'g1' });
    const tasks = googleTasks[user];
    const m = rest.match(/^lists\/g1\/tasks(?:\/([^/]+))?$/);
    if (!m) return fail(404, 'Not found');
    const task = m[1] && tasks.find(t => t.id === m[1]);
    if (m[1] && !task) return fail(404, 'Not found');
    if (req.method === 'GET' && !m[1]) return json(200, { items: tasks.filter(t => q.get('showCompleted') !== 'false' || t.status !== 'completed') });
    if (req.method === 'GET') return json(200, task);
    if (req.method === 'POST') { const t = { id: 'g' + (++made + 100), position: '0', status: 'needsAction', ...JSON.parse(body || '{}') }; tasks.unshift(t); return json(200, t); }
    if (req.method === 'PATCH') { Object.assign(task, JSON.parse(body || '{}')); return json(200, task); }
    if (req.method === 'DELETE') { tasks.splice(tasks.indexOf(task), 1); return json(204); }
  }

  // Google Drive
  if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
    const boundary = req.headers['content-type'].split('boundary=')[1];
    const [metaPart, contentPart] = body.split('--' + boundary).slice(1, 3).map(p => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
    const info = JSON.parse(metaPart);
    const f = { id: 'file' + (++made), name: info.name, mimeType: info.mimeType, version: 1, content: contentPart, trashed: false, owner: user,
      perms: [{ id: 'p-' + user, role: 'owner', type: 'user', emailAddress: user + '@example.com', displayName: user[0].toUpperCase() + user.slice(1) }] };
    files[f.id] = f;
    picked[user].add(f.id);
    return json(200, meta(f, user));
  }
  if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
    return json(200, { files: Object.values(files).filter(f => canOpen(f, user) && f.mimeType === TYPE).map(f => meta(f, user)) });
  }
  if (url.pathname === '/drive/v3/about') return json(200, { user: { permissionId: 'p-' + user } });
  const m = url.pathname.match(/^\/(upload\/)?drive\/v3\/files\/([^/]+)(?:\/permissions(?:\/([^/]+))?)?$/);
  const f = m && files[m[2]];
  if (!m || !canOpen(f, user)) return fail(404, 'File not found: ' + (m && m[2]) + '.');
  if (url.pathname.includes('/permissions')) {
    const mine = f.owner === user;
    if (req.method === 'GET') return json(200, { permissions: f.perms });
    if (req.method === 'POST') {
      const p = JSON.parse(body);
      if (!p.emailAddress.endsWith('@example.com')) return fail(400, 'Bad Request. User message: "This email isn’t a Google account."');
      const name = p.emailAddress.split('@')[0];
      f.perms.push({ id: 'p-' + name, role: p.role, type: 'user', emailAddress: p.emailAddress, displayName: name[0].toUpperCase() + name.slice(1), photoLink: base + 'icons/icon-32.png' });
      f.note = q.get('emailMessage');
      return json(200, {});
    }
    if (req.method === 'DELETE') {
      if (!mine && m[3] !== 'p-' + user) return fail(403, 'Insufficient permissions');
      f.perms = f.perms.filter(p => p.id !== m[3]);
      return json(204);
    }
  }
  if (req.method === 'GET' && q.get('alt') === 'media') { res.writeHead(200, { 'Content-Type': TYPE }); return res.end(f.content); }
  if (req.method === 'GET') return json(200, meta(f, user));
  if (req.method === 'PATCH' && m[1]) { f.content = body; f.version++; return json(200, { version: String(f.version) }); }
  if (req.method === 'PATCH') {
    const change = JSON.parse(body);
    if (change.trashed && f.owner !== user) return fail(403, 'Insufficient permissions');
    Object.assign(f, change);
    f.version++;
    return json(200, meta(f, user));
  }
  fail(400, 'Unexpected');
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const raw = req.url;
    if (raw.startsWith('/fake/')) return fake(req, res, raw.slice(5), body);
    if (raw.startsWith('/grant?')) { const q = new URL(raw, 'http://x').searchParams; picked[q.get('user')].add(q.get('id')); res.writeHead(204); return res.end(); }
    const path = normalize(decodeURIComponent(new URL(raw, 'http://x').pathname)).replace(/^([/\\])+/, '') || 'index.html';
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
const dir = mkdtempSync(join(tmpdir(), 'tabandtick-shared-'));
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir,
  '--no-first-run', '--no-sandbox', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));
let port;
for (let i = 0; i < 100 && !port; i++) {
  try { port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await wait(200); }
}
const KEYS = { ArrowUp: 38, ArrowDown: 40, Tab: 9, Backspace: 8, Enter: 13, Escape: 27, a: 65 };

async function person(name, hash = '') {
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = {}, errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
  };
  const cdp = (method, params = {}) => new Promise(r => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  const js = async expr => {
    const m = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.result.exceptionDetails) throw new Error(name + ': ' + JSON.stringify(m.result.exceptionDetails));
    return m.result.result.value;
  };
  const key = async (k, mods = []) => {
    const bits = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
    const modifiers = mods.reduce((a, x) => a | bits[x], 0);
    const base = { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, windowsVirtualKeyCode: KEYS[k], modifiers };
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await wait(40);
  };
  const type = async text => { await cdp('Input.insertText', { text }); await wait(40); };
  await cdp('Runtime.enable');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Page.enable');
  const signIn = `
    API = '${base}fake/tasks/v1/';
    shared.base = '${base}fake/';
    auth.token = function() { return '${name}'; };
    auth.hasDrive = function() { return true; };
    auth.drive = function(done) { done(true); };
    auth.canShare = true;
    auth.silent = function(done) { done(true); };
    loadProfile = function() {};
    tickPause = closeTime = 0;
    currentAccount('${name}@example.com');
    // Picking the file in Google's picker lets this person open it
    shared.pick = function(id, done) { fetch('${base}grant?user=${name}&id=' + id).then(function() { done(id); }); };
    hideMessage(); $('#authorize-div').hide();
    checkAuth(); true`;
  const load = async url => {
    await cdp('Page.navigate', { url });
    await wait(800);
    await js(signIn);
  };
  await load(base + 'index.html' + hash);
  await wait(1200);
  return { name, js, key, type, errors, cdp, load };
}

// SHOTS=folder saves pictures of the screens along the way
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
// What a person sees in a list: titles in order, subtasks with a dash, ticked with an x
const seen = (p, title) => p.js(`(function() {
  var card = $('#cards .card').filter(function() { return $(this).find('.list-title').val() === ${JSON.stringify(title)}; });
  if (!card.length) return null;
  return card.find('.claire li').map(function() {
    var t = $(this).children('.todo');
    return ($(this).hasClass('subtask') ? '-' : '') + t.val() + (t.hasClass('checked') ? ' x' : '');
  }).get().join(', ');
})()`);
const sidebar = p => p.js(`$('#lists .name').map(function() { return this.textContent; }).get().join(', ')`);
const fileTasks = id => Object.values(JSON.parse(files[id].content).tasks).map(t => t.title).sort().join(', ');
const settle = async (...people) => { // everyone saves, then everyone looks
  await wait(900);
  for (const p of people) await p.js(`shared.check(); true`);
  await wait(500);
  for (const p of people) await p.js(`shared.check(); true`);
  await wait(400);
};

// ---- Positions and merging, on their own
const alex = await person('alex');
check('positions go between their neighbours', await alex.js(`(function() {
  var b = shared.between, a = b('', null), c = b(a, null), m = b(a, c), first = b('', a), z = b('00000000000000000010', '00000000000000000011');
  return [a < m && m < c, first < a, z > '00000000000000000010' && z < '00000000000000000011', b('5', '5') > '5'];
})()`), [true, true, true, true]);
check('a merge keeps the later change to each task, and deletions', await alex.js(`(function() {
  var ours = { tasks: { a: { id: 'a', title: 'Milk', updated: '2026-01-02' }, b: { id: 'b', title: 'Bread', updated: '2026-01-01' } }, deleted: {} };
  var now = new Date().toISOString();
  var theirs = { tasks: { a: { id: 'a', title: 'Oat milk', updated: '2026-01-01' }, c: { id: 'c', title: 'Eggs', updated: '2026-01-03' } }, deleted: { b: now } };
  var m = shared.merge(ours, theirs);
  return Object.keys(m.tasks).sort().map(function(k) { return m.tasks[k].title; }).join(', ') + ' / ' + Object.keys(m.deleted).join(',');
})()`), 'Milk, Eggs / b');

// ---- Alex makes a shared list and shares it with Sam
check('Alex sees a button to make a shared list', await alex.js(`$('#new-shared').is(':visible')`), true);
await alex.js(`$('#new-shared').click(); true`);
await wait(100);
await alex.type('Shopping');
await alex.js(`$('#dialog form')[0].requestSubmit(); true`);
await wait(600);
check('the list is made in Drive, and shown', [Object.values(files).map(f => f.name), await sidebar(alex)], [['Shopping (Tab & Tick)'], 'My Tasks, Shopping']);
check('the share dialog opens', await alex.js(`$('#share')[0].open && $('#share h2').text()`), 'Share “Shopping”');
await wait(300);
check('it lists Alex as the owner', await alex.js(`$('#share .people li').map(function() { return $(this).text(); }).get()`), ['AAlexalex@example.comOwner']);
await alex.js(`$('#share input[type=email]').focus(); true`);
await alex.type('nobody@elsewhere.net');
await alex.js(`$('#share form')[0].requestSubmit(); true`);
await wait(300);
check('an email that isn’t a Google account is refused, with why', await alex.js(`$('#message span').text()`), 'Could not share with nobody@elsewhere.net. Check it’s a Google account.');
await alex.js(`$('#share input[type=email]').val('').focus(); true`);
await alex.type('sam@example.com');
await alex.js(`$('#share form')[0].requestSubmit(); true`);
await wait(400);
const fileId = Object.keys(files)[0];
check('sharing gives Sam access, and Drive’s email has the link', [files[fileId].perms.map(p => p.id + ':' + p.role), files[fileId].note],
  [['p-alex:owner', 'p-sam:writer'], 'Open it in Tab & Tick: ' + base + 'index.html#open=' + fileId]);
await shot(alex, 'share-dialog');
check('and Sam is listed', await alex.js(`$('#share .people .name').map(function() { return this.textContent; }).get()`), ['Alex', 'Sam']);
check('the dialog shows each person’s picture, or their initial', await alex.js(`$('#share .people li').map(function() { var f = $(this).children('.face'); return f.is('img') ? 'picture' : f.text(); }).get()`), ['A', 'picture']);
check('and the list shows Sam’s picture by its Share button', await alex.js(`[$('.card.shared .sharers img.face').length, $('.card.shared .sharers').attr('title')]`), [1, 'Shared with Sam']);
await alex.js(`$('#share .close').click(); true`);

// Alex writes the list, as with any other
await alex.js(`$('#cards .card.shared .new-task').click(); true`);
await alex.type('Milk'); await alex.key('Enter');
await alex.type('Bread'); await alex.key('Enter');
await alex.type('Seeded'); await alex.key('Tab');
await wait(1200);
check('Alex’s tasks are saved to the file', fileTasks(fileId), 'Bread, Milk, Seeded');
check('as Alex wrote them', await seen(alex, 'Shopping'), 'Milk, Bread, -Seeded');

// ---- Sam opens the link
const sam = await person('sam', '#open=' + fileId);
check('Sam is asked to open it', await sam.js(`$('#dialog')[0].open && $('#dialog h2').text()`), 'Open a shared list?');
await sam.js(`$('#dialog form')[0].requestSubmit(); true`);
await wait(800);
check('Sam sees the list, as Alex has it', [await sidebar(sam), await seen(sam, 'Shopping')], ['My Tasks, Shopping', 'Milk, Bread, -Seeded']);
check('the link is gone from the address', await sam.js(`location.hash`), '');
await wait(300);
check('Sam’s list shows Alex, not Sam', await sam.js(`[$('.card.shared .sharers .face').text(), $('.card.shared .sharers').attr('title')]`), ['A', 'Shared with Alex']);
await shot(sam, 'sam-list');
check('Sam’s menu says Leave, not Delete', await sam.js(`$('.card.shared [data-list-do=delete]').text()`), 'Leave list');

// ---- Both change it at once
await sam.js(`$('.card.shared .todo').filter(function() { return this.value === 'Milk'; }).siblings('input[type=checkbox]').click(); true`);
await alex.js(`var t = $('.card.shared .todo').filter(function() { return this.value === 'Bread'; }); t.focus(); t.setCursorPosition(5); true`);
await alex.key('Enter');
await alex.type('Butter');
await wait(1000);
await settle(alex, sam);
check('Alex sees Sam’s tick, and Sam sees Alex’s new task', [await seen(alex, 'Shopping'), await seen(sam, 'Shopping')],
  ['Bread, -Butter, -Seeded', 'Bread, -Butter, -Seeded']);
check('the file has both', [fileTasks(fileId), JSON.parse(files[fileId].content).tasks[Object.keys(JSON.parse(files[fileId].content).tasks).find(k => JSON.parse(files[fileId].content).tasks[k].title === 'Milk')].status],
  ['Bread, Butter, Milk, Seeded', 'completed']);

// Sam is typing when Alex's change comes: Sam's typing stays, and the change shows once it's saved
await sam.js(`var t = $('.card.shared .todo').filter(function() { return this.value === 'Butter'; }); t.focus(); t.setCursorPosition(6); true`);
await sam.type(' (salted)');
await alex.js(`var t = $('.card.shared .todo').filter(function() { return this.value === 'Butter'; }); t.focus(); t.setCursorPosition(6); true`);
await alex.key('Enter');
await alex.type('Jam');
await wait(700);
await sam.js(`shared.check(); true`);
await wait(300);
check('while Sam types, the list isn’t redrawn under them', [await seen(sam, 'Shopping'), await sam.js(`document.activeElement.value`)], ['Bread, -Butter (salted), -Seeded', 'Butter (salted)']);
await settle(alex, sam);
await wait(1200);
await settle(alex, sam);
check('then both have both changes', [await seen(alex, 'Shopping'), await seen(sam, 'Shopping')],
  ['Bread, -Butter (salted), -Jam, -Seeded', 'Bread, -Butter (salted), -Jam, -Seeded']);
check('and Sam is still typing where they were', await sam.js(`[document.activeElement.value, document.activeElement.selectionStart]`), ['Butter (salted)', 15]);

// A deletion reaches the other person
await sam.js(`document.activeElement.blur(); var t = $('.card.shared .todo').filter(function() { return this.value === 'Jam'; }); t.focus(); t.select(); true`);
await sam.key('Backspace'); await sam.key('Backspace');
await sam.js(`finishRemovals(); true`);
await settle(sam, alex);
check('Sam deletes Jam, and it goes for Alex too', [await seen(sam, 'Shopping'), await seen(alex, 'Shopping'), fileTasks(fileId)],
  ['Bread, -Butter (salted), -Seeded', 'Bread, -Butter (salted), -Seeded', 'Bread, Butter (salted), Milk, Seeded']);

// Moving a task in from a Google Tasks list
await alex.js(`moveToList($('.card:not(.shared) .todo').filter(function() { return this.value === 'Call the plumber'; }), 'drive:${fileId}'); true`);
await wait(800);
await settle(alex, sam);
check('a task moved in from Google Tasks leaves it, and Sam sees it', [googleTasks.alex.map(t => t.title), await seen(sam, 'Shopping')],
  [[], 'Call the plumber, Bread, -Butter (salted), -Seeded']);
await alex.js(`$('#message button').click(); true`); // Undo
await wait(800);
await settle(alex, sam);
check('undoing puts it back in Google Tasks', [googleTasks.alex.map(t => t.title), await seen(sam, 'Shopping')],
  [['Call the plumber'], 'Bread, -Butter (salted), -Seeded']);

// Renaming
await alex.js(`$('.card.shared .list-title').val('Food shop').trigger('change'); true`);
await wait(400);
await settle(sam);
check('a new name reaches Drive and Sam', [files[fileId].name, await sidebar(sam)], ['Food shop (Tab & Tick)', 'My Tasks, Food shop']);

// A Google Tasks list can be shared as a copy
await alex.js(`shareList('g1'); true`);
check('sharing a Google Tasks list offers a shared copy', await alex.js(`$('#dialog h2').text() + ' / ' + $('#dialog .ok').text()`), 'Share “My Tasks”? / Make a shared copy');
await alex.js(`$('#dialog form')[0].requestSubmit(); true`);
await wait(800);
check('which is made, with its tasks', [await sidebar(alex), await alex.js(`$('.card.shared').last().find('.claire .todo').map(function() { return this.value; }).get().join()`) === 'Call the plumber', Object.values(files).filter(f => f.name === 'My Tasks (Tab & Tick)').map(f => fileTasks(f.id))],
  ['My Tasks, Food shop, My Tasks', true, ['Call the plumber']]);
await alex.js(`$('#share')[0].close(); true`);

// Sam leaves; Alex deletes
await sam.js(`shared.remove('drive:${fileId}'); true`);
await wait(100);
check('leaving asks first', await sam.js(`$('#dialog h2').text()`), 'Leave “Food shop”?');
await sam.js(`$('#dialog form')[0].requestSubmit(); true`);
await wait(500);
check('Sam leaves the list', [files[fileId].perms.map(p => p.id), await sidebar(sam)], [['p-alex'], 'My Tasks']);
await alex.js(`shared.remove('drive:${fileId}'); true`);
await wait(100);
await alex.js(`$('#dialog form')[0].requestSubmit(); true`);
await wait(500);
check('Alex’s goes to the bin in Drive', [files[fileId].trashed, await sidebar(alex)], [true, 'My Tasks, My Tasks']);

// After a refresh, Alex's shared lists are found in Drive again
await alex.load(base + 'index.html');
await wait(1500);
check('after a refresh, shared lists are found again', await sidebar(alex), 'My Tasks, My Tasks');

check('no errors in either page', [...alex.errors, ...sam.errors], []);
if (failures) console.log('\nRequests:\n' + requests.slice(-40).join('\n'));
console.log(failures ? failures + ' failed' : 'all passed');
chrome.kill();
server.close();
process.exit(failures ? 1 : 0);
