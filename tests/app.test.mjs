// Tests the app in headless Chrome, with real key presses and clicks, against a
// small fake of Google Tasks that refuses what the real one refuses.
//
//   node tests/app.test.mjs        (Node 22 or later, and Chrome)
//
// Set CHROME to Chrome's path if it isn't where this looks.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '') || 'index.html';
  const file = join(app, path);
  if (!file.startsWith(app) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/';

const chromePath = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!chromePath) { console.error('Chrome not found: set CHROME to its path'); process.exit(2); }
const dir = mkdtempSync(join(tmpdir(), 'tabandtick-test-'));
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir,
  '--no-first-run', '--no-sandbox', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 100 && !targets; i++) {
  try {
    const port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  } catch { await wait(200); }
}
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = {};
const pageErrors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
};
const cdp = (method, params = {}) => new Promise(r => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
const js = async expr => {
  const m = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (!m.result) throw new Error("CDP: " + JSON.stringify(m.error));
  if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
  return m.result.result.value;
};
const KEYS = { ArrowUp: 38, ArrowDown: 40, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, Enter: 13, z: 90 };
async function mouse(type, x, y) {
  await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await wait(30);
}
async function hover(x, y) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }); await wait(30); }
async function click(x, y) { await hover(x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await wait(50); }
const box = sel => js(`(function() { var r = (${sel}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.top, r.bottom]; })()`);
const dayIso = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T00:00:00.000Z'; };
const rowOf = title => `$('.claire .todo').filter(function() { return this.value === '${title}'; }).parent()[0]`;
async function key(name, mods = []) {
  const m = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const modifiers = mods.reduce((a, k) => a | m[k], 0);
  const code = name.length === 1 ? 'Key' + name.toUpperCase() : name;
  const base = { key: name, code, windowsVirtualKeyCode: KEYS[name], modifiers };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await wait(50);
}
let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : '\n   got  ' + JSON.stringify(got) + '\n   want ' + JSON.stringify(want)));
}

await cdp('Page.enable');
await cdp('Runtime.enable'); // to hear of errors in the page
await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
await cdp('Page.navigate', { url: base + 'index.html' });
await wait(1500);
await js(`
  window.sent = [];
  // A small Google: refuses a move whose parent is a subtask, or whose previous
  // task isn't under that parent, as the real one does.
  window.server = []; window.serverErrors = []; window.made = 0;
  window.setServer = function(tasks) { server = tasks.map(function(t) { return { id: t.id, parent: t.parent }; }); };
  window.send = function(method, path, body, done, failed) {
    var got = method === 'GET' && window.answerGet && answerGet(path); // a test's own answer
    if (got) return setTimeout(function() { if (done) done(got); }, 10);
    if (method === 'PATCH') return setTimeout(function() { if (done) done(body); }, 10); // saving a change
    if (method === 'DELETE') return setTimeout(function() {
      var gone = path.split('/').pop();
      server = server.filter(function(t) { return t.id !== gone; });
      if (done) done();
    }, 10);
    if (method === 'POST' && path.indexOf('/move') < 0 && path.split('?')[0].slice(-6) === '/tasks') { // making a task, slowly
      var cq = new URLSearchParams(path.split('?')[1] || '');
      return setTimeout(function() {
        var parent = cq.get('parent') || undefined, previous = cq.get('previous');
        var findc = function(x) { return server.find(function(t) { return t.id === x; }); };
        if ((parent && (!findc(parent) || findc(parent).parent)) || (previous && (!findc(previous) || findc(previous).parent !== parent))) {
          serverErrors.push('create ' + decodeURIComponent(path)); return failed && failed(400);
        }
        var task = { id: 'n' + (++window.made), parent: parent };
        (window.log = window.log || []).push('make ' + task.id + ' "' + (body && body.title) + '" ' + decodeURIComponent(path.split('?')[1] || ''));
        server.splice(previous ? server.indexOf(findc(previous)) + 1 : 0, 0, task);
        if (done) done({ id: task.id, parent: parent, title: body && body.title });
      }, 300);
    }
    var at = path.indexOf('/move');
    if (at < 0) return;
    var m = [null, path.slice(0, at).split('/').pop(), null, path.split('?')[1] || ''];
    sent.push(decodeURIComponent(path));
    var q = new URLSearchParams(m[3] || '');
    setTimeout(function() {
      if (q.get('destinationTasklist')) return done && done({});
      var id = m[1], parent = q.get('parent') || undefined, previous = q.get('previous');
      var find = function(x) { return server.find(function(t) { return t.id === x; }); };
      var bad = !find(id) || (parent && (!find(parent) || find(parent).parent || parent === id ||
        server.some(function(s) { return s.parent === id; }))) || (previous && (!find(previous) || find(previous).parent !== parent));
      if (bad) { serverErrors.push(decodeURIComponent(path)); return failed && failed(400); }
      var task = find(id);
      (window.log = window.log || []).push('move ' + id + ' ' + decodeURIComponent(m[3] || ''));
      server.splice(server.indexOf(task), 1);
      task.parent = parent;
      server.splice(previous ? server.indexOf(find(previous)) + 1 : 0, 0, task);
      if (done) done({});
    }, 80);
  };
  window.serverOrder = function() {
    return server.filter(function(t) { return !t.parent; }).map(function(t) {
      return [t.id].concat(server.filter(function(s) { return s.parent === t.id; }).map(function(s) { return '-' + s.id; })).join(' ');
    }).join(' ');
  };
  window.screenOrder = function() {
    return $('.claire li').map(function() { return ($(this).hasClass('subtask') ? '-' : '') + $(this).children('.todo').attr('id'); }).get().join(' ');
  };

  $('body').addClass('signed-in');
  lists = [{ id: 'L1', title: 'Test' }];
  var card = newCard(lists[0]); card[0].loaded = true; $('#cards').append(card);
  lists.push({ id: 'L2', title: 'Other' });
  setServer(window.FIRST = [
    { id: 'a', title: 'Alpha', position: '1' }, { id: 'b', title: 'Bravo', position: '2' },
    { id: 'c', title: 'Charlie', position: '3' }, { id: 'c1', title: 'Sub', parent: 'c', position: '1' },
    { id: 'd', title: 'Delta', position: '4' }]);
  showTasks(card, FIRST);
  window.state = function() {
    return {
      order: $('.claire li').map(function() { return ($(this).hasClass('subtask') ? '-' : '') + $(this).children('.todo').val(); }).get().join(' '),
      picked: $('li.picked .todo').map(function() { return this.value; }).get().join(' '),
      focus: document.activeElement.tagName + (document.activeElement.value ? ':' + document.activeElement.value : '')
    };
  };
  window.focusRow = function(title) {
    var t = $('.claire .todo').filter(function() { return this.value === title; });
    t.setCursorPosition(t.val().length);
  };
  true`);
const s = () => js('state()');

await js(`focusRow('Bravo')`);
await key('ArrowDown', ['shift']);
check('Shift+Down picks this row and the next', (await s()).picked, 'Bravo Charlie');
check('focus moves to the list', (await s()).focus, 'UL');
await key('ArrowDown', ['shift']);
check('Shift+Down again extends', (await s()).picked, 'Bravo Charlie Sub');
await key('ArrowUp', ['shift']);
check('Shift+Up shrinks', (await s()).picked, 'Bravo Charlie');

await key('ArrowUp', ['alt']);
check('Alt+Up moves the picked tasks together', (await s()).order, 'Bravo Charlie -Sub Alpha Delta');
check('still picked after moving', (await s()).picked, 'Bravo Charlie');
await key('ArrowUp', ['alt']);
check('Alt+Up at the top does nothing', (await s()).order, 'Bravo Charlie -Sub Alpha Delta');
await key('ArrowDown', ['alt']);
await key('ArrowDown', ['alt']);
check('Alt+Down twice', (await s()).order, 'Alpha Delta Bravo Charlie -Sub');
await key('z', ['meta']);
check('Cmd+Z undoes one whole move', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');

await js(`focusRow('Alpha')`);
check('clicking/focusing a row stops picking', (await s()).picked, '');
await key('ArrowDown', ['shift']);
await key('Tab');
check('Tab indents the picked rows', (await s()).order, 'Alpha -Bravo Charlie -Sub Delta');
await key('Tab', ['shift']);
check('Shift+Tab moves them out', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');

await key('Escape');
check('Escape stops picking', (await s()).picked, '');
check('...and goes back to typing in the row', (await s()).focus, 'TEXTAREA:Bravo');

await js(`focusRow('Delta')`);
await key('ArrowUp', ['shift']);
check('Shift+Up from the last row', (await s()).picked, 'Sub Delta');
await key('ArrowDown', ['shift']);
check('Shift+Down shrinks back towards where it started', (await s()).picked, 'Delta');
await key('ArrowUp', ['shift']);
await key('ArrowUp', ['shift']);
await key('ArrowUp', ['shift']);
check('back up two more', (await s()).picked, 'Bravo Charlie Sub Delta');
await key('ArrowUp');
check('Up stops, caret in the first picked row', (await s()).focus, 'TEXTAREA:Bravo');

await key('ArrowDown', ['shift']);
await key('Backspace');
check('Backspace deletes the picked tasks and subtasks', (await s()).order, 'Alpha Delta');
check('focus goes to the next row', (await s()).focus, 'TEXTAREA:Delta');
check('message', await js(`$('#message').text()`), '3 tasks deleted. Undo');
await key('z', ['meta']);
check('Cmd+Z brings them all back', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');

await js(`focusRow('Alpha')`);
await key('ArrowDown', ['shift']);
const copied = await js(`(function() {
  var data = new DataTransfer(), e = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
  document.activeElement.dispatchEvent(e); return data.getData('text/plain'); })()`);
check('copy gives the titles', copied, 'Alpha\nBravo');


// Dragging the picked rows
await js(`$('#message').hide(); focusRow('Alpha')`);
await key('ArrowDown', ['shift']);
check('picked for dragging', (await s()).picked, 'Alpha Bravo');
let [hx, hy] = await box(`$(${rowOf('Alpha')}).children('.handle')[0]`);
await hover(hx, hy);
await mouse('mousePressed', hx, hy);
const d = await box(rowOf('Delta'));
for (const y of [hy + 20, hy + 60, d[3] - 2]) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y, button: 'left', buttons: 1 });
await wait(50);
await mouse('mouseReleased', hx, d[3] - 2);
check('dragging moves all the picked tasks', (await s()).order, 'Charlie -Sub Delta Alpha Bravo');
check('still picked after dragging', (await s()).picked, 'Alpha Bravo');
await key('z', ['meta']);
check('Cmd+Z undoes the whole drag', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');

// Dragging picked rows in among subtasks
async function dragPicked(from, toY, dx = 0) {
  const [x, y] = await box(`$(${rowOf(from)}).children('.handle')[0]`);
  await hover(x, y);
  await mouse('mousePressed', x, y);
  for (const yy of [y + 10, (y + toY) / 2, toY]) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y: yy, button: 'left', buttons: 1 });
  await wait(50);
  await mouse('mouseReleased', x + dx, toY);
}
await js(`focusRow('Alpha')`);
await key('ArrowDown', ['shift']);
let c = await box(rowOf('Charlie'));
await dragPicked('Alpha', c[3] + 2);
check('dropped between a task and its subtasks, they become subtasks', (await s()).order, 'Charlie -Alpha -Bravo -Sub Delta');
check('still picked', (await s()).picked, 'Alpha Bravo');
await key('z', ['meta']);
check('one undo puts them back', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');

await js(`focusRow('Alpha')`);
await key('ArrowDown', ['shift']);
let sb = await box(rowOf('Sub'));
await dragPicked('Alpha', sb[3] - 2, 40);
check('dragged right below the last subtask, they join them', (await s()).order, 'Charlie -Sub -Alpha -Bravo Delta');
await key('z', ['meta']);

await js(`focusRow('Bravo')`);
await key('ArrowDown', ['shift']);
check('a task with its subtask picked', (await s()).picked, 'Bravo Charlie');
let dl = await box(rowOf('Delta'));
await dragPicked('Bravo', dl[3] - 2, 40);
check('a task with subtasks stays a top-level task', (await s()).order, 'Alpha Delta Bravo Charlie -Sub');
await key('z', ['meta']);
check('back', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');

// Moving out several subtasks keeps their order
const reset = async tasks => { for (let i = 0; i < 100 && await js('moves.length'); i++) await wait(50); return js(`undoStack = []; setServer(${JSON.stringify(tasks)}); showTasks($('#cards .card').first(), ${JSON.stringify(tasks)}); true`); };
await reset([{ id: 't1', title: 'One', position: '1' }, { id: 't2', title: 'Two', parent: 't1', position: '1' },
  { id: 't3', title: 'Three', parent: 't1', position: '2' }, { id: 't4', title: 'Four', parent: 't1', position: '3' }]);
check('setup', (await s()).order, 'One -Two -Three -Four');
await js(`focusRow('Three')`);
await key('ArrowDown', ['shift']);
await key('Tab', ['shift']);
check('Shift+Tab on the last two keeps their order', (await s()).order, 'One -Two Three Four');
await key('z', ['meta']);
check('one undo', (await s()).order, 'One -Two -Three -Four');
await js(`focusRow('Two')`);
await key('ArrowDown', ['shift']);
await key('Tab', ['shift']);
check('Shift+Tab on the first two: the one below joins the last', (await s()).order, 'One Two Three -Four');
await key('z', ['meta']);
await js(`focusRow('Two')`);
await key('ArrowDown', ['shift']); await key('ArrowDown', ['shift']);
await key('Tab', ['shift']);
check('Shift+Tab on all three keeps their order', (await s()).order, 'One Two Three Four');
await key('Escape');
await reset([{ id: 'a', title: 'Alpha', position: '1' }, { id: 'b', title: 'Bravo', position: '2' },
  { id: 'c', title: 'Charlie', position: '3' }, { id: 'c1', title: 'Sub', parent: 'c', position: '1' },
  { id: 'd', title: 'Delta', position: '4' }]);

// Indenting and moving out quickly, many times: Google ends up as the screen shows
async function settled() {
  for (let i = 0; i < 100 && await js('moves.length || busy()'); i++) await wait(50); // moved, made and saved
  return [await js('serverErrors'), await js('serverOrder()'), await js('screenOrder()')];
}
async function rapid(label, tasks, first, picks, keys) {
  await reset(tasks);
  await js(`serverErrors = []; focusRow('${first}')`);
  for (let i = 0; i < picks; i++) await key('ArrowDown', ['shift']);
  for (const k of keys) await key(...k);
  const [errors, google, screen] = await settled();
  check(label + ': Google refused nothing', errors, []);
  check(label + ': Google has what the screen shows', google, screen);
  await key('Escape');
}
const fam = [{ id: 't1', title: 'One', position: '1' }, { id: 't2', title: 'Two', parent: 't1', position: '1' },
  { id: 't3', title: 'Three', parent: 't1', position: '2' }, { id: 't4', title: 'Four', position: '2' }];
const TAB = ['Tab'], OUT = ['Tab', ['shift']], UP = ['ArrowUp', ['alt']], DOWN = ['ArrowDown', ['alt']];
await rapid('out, in, out, in, out', fam, 'Two', 1, [OUT, TAB, OUT, TAB, OUT]);
await rapid('out, in, out, in', fam, 'Two', 1, [OUT, TAB, OUT, TAB]);
await rapid('just the last one, out and in', fam, 'Three', 0, [OUT, TAB, OUT, TAB, OUT]);
await rapid('out, then move about', fam, 'Two', 1, [OUT, UP, DOWN, DOWN, TAB, OUT, UP]);
await reset([{ id: 'a', title: 'Alpha', position: '1' }, { id: 'b', title: 'Bravo', position: '2' },
  { id: 'c', title: 'Charlie', position: '3' }, { id: 'c1', title: 'Sub', parent: 'c', position: '1' },
  { id: 'd', title: 'Delta', position: '4' }]);
await js(`$('#message').hide(); true`);

// Moving one subtask out: those below it become its subtasks
async function googleMatches(label) {
  await js('finishRemovals(); true'); // rather than wait out the time to undo
  const [errors, google, screen] = await settled();
  check(label + ': Google refused nothing', errors, []);
  check(label + ': Google has what the screen shows', google, screen);
  if (google !== screen) console.log('   what Google was asked:\n     ' + (await js('window.log || []')).join('\n     '));
  await js('window.log = []; true');
}
const fam5 = [{ id: 't1', title: 'One', position: '1' }, { id: 't2', title: 'Two', parent: 't1', position: '1' },
  { id: 't3', title: 'Three', parent: 't1', position: '2' }, { id: 't4', title: 'Four', parent: 't1', position: '3' },
  { id: 't5', title: 'Five', parent: 't1', position: '4' }, { id: 't6', title: 'Six', position: '2' }];
await reset(fam5);
await js(`serverErrors = []; focusRow('Three')`);
await key('Tab', ['shift']);
check('Shift+Tab on a middle subtask: it stays put and takes those below', (await s()).order, 'One -Two Three -Four -Five Six');
check('the caret stays in it', (await s()).focus, 'TEXTAREA:Three');
await googleMatches('middle');
await key('z', ['meta']);
check('one Cmd+Z puts it all back', (await s()).order, 'One -Two -Three -Four -Five Six');
await googleMatches('undo');
await js(`focusRow('Two')`);
await key('Tab', ['shift']);
check('the first subtask takes all the rest', (await s()).order, 'One Two -Three -Four -Five Six');
await googleMatches('first');
await js(`focusRow('Five')`);
await key('Tab', ['shift']);
check('the last one takes none', (await s()).order, 'One Two -Three -Four Five Six');
await googleMatches('last');
await js(`focusRow('Two')`);
await key('Tab');
check('Tab on a task with subtasks nests it, and they come along', (await s()).order, 'One -Two -Three -Four Five Six');
check('caret stays', (await s()).focus, 'TEXTAREA:Two');
await googleMatches('tab with subtasks');
await key('z', ['meta']);
check('one Cmd+Z', (await s()).order, 'One Two -Three -Four Five Six');
await googleMatches('undo tab');
await js(`focusRow('Five')`); await key('Tab');
check('setup: Two -Three -Four -Five', (await s()).order, 'One Two -Three -Four -Five Six');
await js(`focusRow('Two')`); await key('Tab');
check('nests under a task that has subtasks, at the end of them', (await s()).order, 'One -Two -Three -Four -Five Six');
await key('Tab', ['shift']);
check('Shift+Tab undoes it the other way', (await s()).order, 'One Two -Three -Four -Five Six');
await googleMatches('round trip');
await js(`$('.claire .todo').filter(function() { return this.id === 't4'; }).addClass('checked').siblings('input').prop('checked', true); focusRow('Two')`);
await key('Tab');
check('with a completed subtask it is refused', [(await s()).order, await js(`$('#message').text().trim()`)],
  ['One Two -Three -Four -Five Six', 'That task has completed subtasks, so it can\u2019t become one.']);
await reset(fam5);
await js(`$('.claire .todo').filter(function() { return this.id === 't4'; }).addClass('checked').siblings('input').prop('checked', true); focusRow('Three')`);
await key('Tab', ['shift']);
check('a completed one below stays with the old parent', (await s()).order, 'One -Two -Four Three -Five Six');
await reset([{ id: 'a', title: 'Alpha', position: '1' }, { id: 'b', title: 'Bravo', position: '2' },
  { id: 'c', title: 'Charlie', position: '3' }, { id: 'c1', title: 'Sub', parent: 'c', position: '1' },
  { id: 'd', title: 'Delta', position: '4' }]);
await js(`$('#message').hide(); true`);

// Typing fast: Tab under a task Google hasn't made yet
await reset([{ id: 't1', title: 'One', position: '1' }]);
await js(`serverErrors = []; focusRow('One')`);
const type = text => cdp('Input.insertText', { text });
await key('Enter'); await type('Two'); await key('Tab');
check('Tab under a task straight away', (await s()).order, 'One -Two');
await key('Enter'); await type('Three'); await key('Enter'); await type('Four');
await key('Enter'); await type('Five'); await key('Tab', ['shift']);
check('typing on', (await s()).order, 'One -Two -Three -Four Five');
await js(`focusRow('One')`); await key('Enter'); await type('New');
check('Enter on a task with subtasks makes the first of them', (await s()).order, 'One -New -Two -Three -Four Five');
await js(`focusRow('Five')`); await key('Enter'); await type('Six'); await key('Enter'); await type('Seven'); await key('Tab');
await js(`var t = $('.claire .todo').filter(function() { return this.value === 'Six'; }); t.setCursorPosition(1); true`);
await key('Enter');
check('Enter in the middle of a task still being made, with a subtask', (await s()).order, 'One -New -Two -Three -Four Five S -ix -Seven');
for (let i = 0; i < 60 && await js('busy()'); i++) await wait(100);
check('everything made and moved', await js('busy()'), false);
await googleMatches('typing fast');
await reset([{ id: 'a', title: 'Alpha', position: '1' }, { id: 'b', title: 'Bravo', position: '2' },
  { id: 'c', title: 'Charlie', position: '3' }, { id: 'c1', title: 'Sub', parent: 'c', position: '1' },
  { id: 'd', title: 'Delta', position: '4' }]);
await js(`$('#message').hide(); true`);

// Backspace joins a task with subtasks; they go with it
const fam6 = [{ id: 'p1', title: 'Alpha', position: '1' }, { id: 'p2', title: 'Beta', position: '2' },
  { id: 'p3', title: 'Gamma', parent: 'p2', position: '1' }, { id: 'p4', title: 'Delta', parent: 'p2', position: '2' }, { id: 'p5', title: 'One', position: '3' }];
const caretIn = (title, at) => js(`var t = $('.claire .todo').filter(function() { return this.value === '${title}'; }); t.setCursorPosition(${at} < 0 ? t.val().length : ${at}); true`);
await reset(fam6);
await js(`serverErrors = []; true`);
await caretIn('Beta', 0);
await key('Backspace');
check('Backspace at the start of Beta joins it to Alpha, taking its subtasks', [(await s()).order, (await s()).focus], ['AlphaBeta -Gamma -Delta One', 'TEXTAREA:AlphaBeta']);
check('the caret is where they meet', await js(`document.activeElement.selectionStart`), 5);
await key('z', ['meta']);
check('one Cmd+Z puts Beta back with its subtasks', (await s()).order, 'Alpha Beta -Gamma -Delta One');
await googleMatches('undo join');
await caretIn('Beta', 0);
await key('Backspace');
await googleMatches('join with subtasks');

await reset([{ id: 'q1', title: 'Pa', position: '1' }, { id: 'q2', title: 'Sa', parent: 'q1', position: '1' },
  { id: 'q3', title: 'Te', position: '2' }, { id: 'q4', title: 'T1', parent: 'q3', position: '1' }, { id: 'q5', title: 'T2', parent: 'q3', position: '2' }]);
await js(`serverErrors = []; true`);
await caretIn('Te', 0);
await key('Backspace');
check('joined onto a subtask, the subtasks go to its parent', (await s()).order, 'Pa -SaTe -T1 -T2');
await googleMatches('join onto a subtask');

await reset([{ id: 'r1', title: 'Ay', position: '1' }, { id: 'r2', title: 'Bee', position: '2' }, { id: 'r3', title: 'B1', parent: 'r2', position: '1' }]);
await js(`serverErrors = []; true`);
await caretIn('Ay', -1);
await key('Delete');
check('Delete at the end of a task joins the next, with its subtask', (await s()).order, 'AyBee -B1');
await googleMatches('delete join');

await reset([{ id: 'a', title: 'Alpha', position: '1' }, { id: 'b', title: 'Bravo', position: '2' },
  { id: 'c', title: 'Charlie', position: '3' }, { id: 'c1', title: 'Sub', parent: 'c', position: '1' },
  { id: 'd', title: 'Delta', position: '4' }]);
await js(`$('#message').hide(); true`);

// Shift+click
async function shiftClick(title, mods = 8) {
  const [x, y] = await box(`$(${rowOf(title)}).children('.todo')[0]`);
  await hover(x, y);
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers: mods });
  await wait(60);
}
await js(`focusRow('Alpha')`);
await shiftClick('Charlie');
check('Shift+click picks from the row being edited', (await s()).picked, 'Alpha Bravo Charlie');
check('focus on the list, no caret', (await s()).focus, 'UL');
await shiftClick('Bravo');
check('Shift+click again moves the end', (await s()).picked, 'Alpha Bravo');
await key('ArrowDown', ['shift']);
check('then Shift+Down carries on', (await s()).picked, 'Alpha Bravo Charlie');
await shiftClick('Delta', 0);
check('a plain click stops picking and edits', [(await s()).picked, (await s()).focus], ['', 'TEXTAREA:Delta']);
await js(`document.activeElement.blur()`);
await shiftClick('Bravo');
check('Shift+click with nothing being edited picks that row', (await s()).picked, 'Bravo');
await shiftClick('Sub');
check('...and the next Shift+click extends from it', (await s()).picked, 'Bravo Charlie Sub');
await key('Escape');

// Cmd+click
const CMD = process.platform === 'darwin' ? 4 : 2, SHIFT = 8; // Cmd on a Mac, Ctrl elsewhere
await js(`focusRow('Alpha')`);
await shiftClick('Charlie', CMD);
check('Cmd+click adds a row, not the ones between', (await s()).picked, 'Alpha Charlie');
await shiftClick('Delta', CMD);
check('Cmd+click another', (await s()).picked, 'Alpha Charlie Delta');
await shiftClick('Charlie', CMD);
check('Cmd+click a picked row takes it away', (await s()).picked, 'Alpha Delta');
await shiftClick('Bravo', SHIFT);
check('Shift+click then adds a range from there', (await s()).picked, 'Alpha Bravo Delta');
await shiftClick('Charlie', SHIFT);
check('...and moves its end, keeping the others', (await s()).picked, 'Alpha Bravo Charlie Delta');
await key('Escape');
await js(`document.activeElement.blur()`);
await shiftClick('Alpha', CMD);
await shiftClick('Charlie', CMD);
check('Cmd+click with nothing being edited', (await s()).picked, 'Alpha Charlie');
await key('ArrowDown', ['shift']);
check('Shift+Down carries on from the last one clicked', (await s()).picked, 'Alpha Charlie Sub');
await shiftClick('Sub', CMD);
await shiftClick('Charlie', CMD);
check('down to one row', (await s()).picked, 'Alpha');
await shiftClick('Alpha', CMD);
check('none left stops picking', [(await s()).picked, await js('picked')], ['', null]);

await js(`focusRow('Bravo')`);
await shiftClick('Delta', CMD);
await key('Backspace');
check('deleting rows apart', (await s()).order, 'Alpha Charlie -Sub');
check('message', await js(`$('#message').text()`), '2 tasks deleted. Undo');
await key('z', ['meta']);
check('Cmd+Z puts each back in its own place', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');

await js(`focusRow('Alpha')`);
await shiftClick('Charlie', CMD);
await key('Backspace');
check('a task and its subtask, apart from another', (await s()).order, 'Bravo Delta');
await key('z', ['meta']);
check('back in place', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');

await js(`$('#message').hide(); focusRow('Alpha')`);
await shiftClick('Charlie', CMD);
const dl2 = await box(rowOf('Delta'));
await dragPicked('Alpha', dl2[3] - 2);
check('dragging rows apart brings them together', (await s()).order, 'Bravo Delta Alpha Charlie -Sub');
await key('z', ['meta']);
check('undo', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');

await js(`focusRow('Alpha')`);
await shiftClick('Charlie', CMD);
await key('ArrowDown', ['alt']);
check('Alt+Down moves each down one', (await s()).order, 'Bravo Alpha Delta Charlie -Sub');
await key('z', ['meta']);
await key('Escape');

// A blank row has a tick circle; ticking one never made just removes it
await js(`var c = $('#cards .card').first(), r = taskRow({}, c); c.find('.claire').prepend(r); refreshRows(); r.children('.todo').focus(); true`);
check('blank row added', (await s()).order, ' Alpha Bravo Charlie -Sub Delta');
check('its circle shows', await js(`getComputedStyle($('.claire li').first().children('input')[0]).visibility`), 'visible');
const [bx, by] = await box(`$('.claire li').first().children('input')[0]`);
await click(bx, by);
check('ticking it removes it', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');

// Leaving a new blank task removes it, as in Google Tasks
const addBlank = () => js(`var c = $('#cards .card').first(), r = taskRow({}, c); c.find('.claire').prepend(r); refreshRows(); r.children('.todo').focus(); true`);
await addBlank();
check('blank task added', (await s()).order, ' Alpha Bravo Charlie -Sub Delta');
let [ax, ay] = await box(`$(${rowOf('Bravo')}).children('.todo')[0]`);
await click(ax, ay);
await wait(50);
check('clicking another task removes it', [(await s()).order, (await s()).focus], ['Alpha Bravo Charlie -Sub Delta', 'TEXTAREA:Bravo']);
await addBlank();
await js(`var r = $('.claire li').first(); openDetails(r); true`);
await wait(50);
check('opening its notes keeps it', (await s()).order, ' Alpha Bravo Charlie -Sub Delta');
await js(`focusRow('Alpha')`); await wait(50);
check('...then leaving the notes for another task removes it', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');
await addBlank();
await key('ArrowDown', ['shift']);
check('picking from it keeps it', (await s()).picked, ' Alpha');
await key('Escape'); await js(`focusRow('Bravo')`); await wait(50);
check('...until it is left', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');
await addBlank();
await key('ArrowDown'); await wait(50);
check('the down arrow leaves it too', [(await s()).order, (await s()).focus], ['Alpha Bravo Charlie -Sub Delta', 'TEXTAREA:Alpha']);
await addBlank();
await cdp('Input.insertText', { text: 'x' });
await js(`focusRow('Bravo')`); await wait(50);
check('one with a title stays', (await s()).order, 'x Alpha Bravo Charlie -Sub Delta');
await js(`$('.claire li').first().children('.todo')[0].deleted = true; $('.claire li').first().remove(); refreshRows(); true`);

// Details under the task being edited
const shown = sel => js(`$(${sel}).is(':visible')`);
const bravo = rowOf('Bravo');
await js(`focusRow('Bravo')`);
check('editing a task shows its details', [await shown(`$(${bravo}).children('.details')`), await shown(`$(${rowOf('Alpha')}).children('.details')`)], [true, false]);
const chip = async label => { const [x, y] = await box(`$(${bravo}).find('.chip').filter(function() { return $(this).text() === '${label}'; })[0]`); await click(x, y); };
const dueOf = () => js(`$(${bravo}).find('.due').val()`);
const today = await js('dayFrom(0)'), tomorrow = await js('dayFrom(1)');
await chip('Tomorrow');
check('Tomorrow sets the date', [await dueOf(), await js(`$(${bravo}).find('[data-due=1]').hasClass('on')`)], [tomorrow, true]);
check('...and the details stay open', await shown(`$(${bravo}).children('.details')`), true);
await chip('Today');
check('Today replaces it', [await dueOf(), await js(`$(${bravo}).find('.on').text()`)], [today, 'Today']);
await chip('Today');
check('Today again takes it off', await dueOf(), '');
await chip('Tomorrow');
const [cx, cy] = await box(`$(${bravo}).find('.clear-due')[0]`);
await click(cx, cy);
check('the cross clears it, and the details stay', [await dueOf(), await shown(`$(${bravo}).find('.clear-due')`), await shown(`$(${bravo}).children('.details')`), (await s()).focus], ['', false, true, 'TEXTAREA:Bravo']);
await js(`$(${bravo}).find('.due').val('2027-03-02').trigger('change'); true`);
check('another date shows on the calendar chip', await js(`$(${bravo}).find('.pick-date').hasClass('on') && $(${bravo}).find('.pick-label').text()`), await js(`dayName('2027-03-02')`));
const [nx, ny] = await box(`$(${bravo}).find('.notes')[0]`);
await click(nx, ny);
await cdp('Input.insertText', { text: 'Some notes' });
check('typing in Details', [await js(`$(${bravo}).find('.notes').val()`), (await s()).focus], ['Some notes', 'TEXTAREA:Some notes']);
await key('Escape');
check('Escape goes back to the title', (await s()).focus, 'TEXTAREA:Bravo');
await js(`focusRow('Alpha')`);
check('leaving hides the details, and the summary shows', [await shown(`$(${bravo}).children('.details')`), await js(`$(${bravo}).find('.meta').text()`)],
  [false, (await js(`dayName('2027-03-02')`)) + 'Some notes']);
await js(`setValues($(${bravo}).children('.todo'), { title: 'Bravo', notes: '', due: '' }); $(${bravo}).children('.todo')[0].saved = current($(${bravo}).children('.todo')); true`);

// Backspace in a task with no title deletes it, notes and date too
await js(`var t = $(${rowOf('Bravo')}).children('.todo'); t[0].lastTitle = 'Bravo'; setValues(t, { title: '', notes: 'Some notes', due: dayFrom(0) }); t.setCursorPosition(0); true`);
await key('Backspace');
check('Backspace deletes it rather than joining it', [(await s()).order, (await s()).focus], ['Alpha Charlie -Sub Delta', 'TEXTAREA:Alpha']);
check('...leaving the task above as it was', await js(`current($(${rowOf('Alpha')}).children('.todo'))`), { title: 'Alpha', notes: '', due: '' });
await key('z', ['meta']);
check('Cmd+Z brings it back, title and all', [(await s()).order, await js(`current($(${rowOf('Bravo')}).children('.todo'))`)],
  ['Alpha Bravo Charlie -Sub Delta', { title: 'Bravo', notes: 'Some notes', due: today }]);
await js(`var t = $(${rowOf('Bravo')}).children('.todo'); setValues(t, { title: 'Bravo', notes: '', due: '' }); t[0].saved = current(t); $('#message').hide(); true`);
await js(`focusRow('Alpha')`);
await key('Enter');
await js(`var t = $('.claire .todo').filter(function() { return !this.value; }); setValues(t, { title: '', notes: 'Unsaved notes', due: '' }); t.setCursorPosition(0); true`);
await key('Backspace');
check('a new one with notes goes too', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');
await key('z', ['meta']);
check('...and comes back', [(await s()).order, await js(`$('.claire li').eq(1).find('.notes').val()`)], [' Bravo Charlie -Sub Delta'.replace(' Bravo', 'Alpha  Bravo'), 'Unsaved notes']);
await js(`var r = $('.claire li').eq(1); r.children('.todo')[0].deleted = true; r.remove(); refreshRows(); $('#message').hide(); true`);

// The menu of a picked row
await js(`focusRow('Alpha')`);
await key('ArrowDown', ['shift']);
let [mx, my] = await box(`$(${rowOf('Bravo')}).children('.more')[0]`);
await click(mx, my);
check('menu opens, still picked', [await js(`$('.menu-open').length`), (await s()).picked], [1, 'Alpha Bravo']);
let [ix, iy] = await box(`$('.menu-open [data-move=down]')[0]`);
await click(ix, iy);
check('Move down from the menu moves them all', (await s()).order, 'Charlie -Sub Alpha Bravo Delta');
check('...and they stay picked, with keys working', (await s()).focus, 'UL');
await key('z', ['meta']);
check('one undo', (await s()).order, 'Alpha Bravo Charlie -Sub Delta');

await js(`focusRow('Alpha')`);
await key('ArrowDown', ['shift']);
[mx, my] = await box(`$(${rowOf('Alpha')}).children('.more')[0]`);
await click(mx, my);
[ix, iy] = await box(`$('.menu-open [data-to=L2]')[0]`);
await js(`sent = []`);
await click(ix, iy);
await wait(300);
check('Move to Other takes both, last first', [(await s()).order, await js('sent')],
  ['Charlie -Sub Delta', ['lists/L1/tasks/b/move?destinationTasklist=L2', 'lists/L1/tasks/a/move?destinationTasklist=L2']]);
check('message', await js(`$('#message').text()`), 'Moved 2 tasks to Other. Undo');

// ---- Dragging does what Tab and Shift+Tab do with subtasks

await reset([{ id: 'g1', title: 'Ann', position: '1' }, { id: 'g2', title: 'Ben', position: '2' },
  { id: 'g3', title: 'Bea', parent: 'g2', position: '1' }, { id: 'g4', title: 'Bo', parent: 'g2', position: '2' }, { id: 'g5', title: 'Cy', position: '3' }]);
await js(`serverErrors = []; $('#message').hide(); true`);
let ann = await box(rowOf('Ann'));
await dragPicked('Ben', ann[3] - 2, 40);
check('dragging a task with subtasks under another: they all go under it, as Tab does', (await s()).order, 'Ann -Ben -Bea -Bo Cy');
await googleMatches('drag a family in');
await key('z', ['meta']);
check('one undo', (await s()).order, 'Ann Ben -Bea -Bo Cy');
await googleMatches('undo the drag');

await reset([{ id: 'h1', title: 'Pa', position: '1' }, { id: 'h2', title: 'S1', parent: 'h1', position: '1' },
  { id: 'h3', title: 'S2', parent: 'h1', position: '2' }, { id: 'h4', title: 'S3', parent: 'h1', position: '3' }, { id: 'h5', title: 'Qu', position: '2' }]);
await js(`serverErrors = []; true`);
let s2 = await box(rowOf('S2'));
await dragPicked('S2', s2[1], -40);
check('dragging a subtask out to the left: the ones below become its own, as Shift+Tab does', (await s()).order, 'Pa -S1 S2 -S3 Qu');
await googleMatches('drag a subtask out');
let s1 = await box(rowOf('S1'));
await dragPicked('S1', s1[1], 0);
check('dragging a subtask without moving left leaves it where it was', (await s()).order, 'Pa -S1 S2 -S3 Qu');

// ---- Pasting several lines, Cmd/Ctrl+Enter, and refreshing on coming back

await reset([{ id: 'p1', title: 'Alpha', position: '1' }, { id: 'p2', title: 'Bravo', position: '2' }]);
await js(`serverErrors = []; $('#message').hide(); true`);
const paste = text => js(`(function() { var d = new DataTransfer(); d.setData('text/plain', ${JSON.stringify(text)});
  document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); return true; })()`);
await caretIn('Alpha', -1);
await paste('One\n- Two\n[ ] Three\n');
check('pasting lines makes a task of each, without list marks', [(await s()).order, (await s()).focus], ['AlphaOne Two Three Bravo', 'TEXTAREA:Three']);
await googleMatches('pasted tasks made');
await key('z', ['meta']);
check('Cmd+Z takes the pasted tasks away', (await s()).order, 'Alpha Bravo');
await js(`finishRemovals(); $('#message').hide(); true`);
await caretIn('Bravo', 2);
await paste('X\nY');
check('pasting in the middle splits the task around the lines', (await s()).order, 'Alpha BrX Yavo');
check('...with the caret after the last line', await js(`[document.activeElement.value, document.activeElement.selectionStart]`), ['Yavo', 1]);
await googleMatches('pasted in the middle');

await reset([{ id: 'k1', title: 'Alpha', position: '1' }, { id: 'k2', title: 'Bravo', position: '2' }, { id: 'k3', title: 'Charlie', position: '3' }, { id: 'k4', title: 'Delta', position: '4' }]);
await js(`$('#message').hide(); true`);
const done = () => js(`$('.done-list .todo').map(function() { return this.value; }).get().join(' ')`);
await caretIn('Alpha', -1);
await key('Enter', ['meta']);
await wait(100);
check('Cmd/Ctrl+Enter ticks the task and goes on to the next', [(await s()).order, await done(), (await s()).focus], ['Bravo Charlie Delta', 'Alpha', 'TEXTAREA:Bravo']);
await key('z', ['meta']);
await wait(100);
check('Cmd+Z reopens it', (await s()).order.split(' ').sort().join(' '), 'Alpha Bravo Charlie Delta');
await js(`$('#message').hide(); true`);
await caretIn('Bravo', -1);
await key('ArrowDown', ['shift']); await key('ArrowDown', ['shift']);
await key('Enter', ['meta']);
await wait(100);
check('Cmd/Ctrl+Enter ticks all the picked tasks', [(await s()).order.split(' ').sort().join(' '), await js(`$('#message').text().trim()`)], ['Alpha', '3 tasks completed. Undo']);
await key('z', ['meta']);
await wait(100);
check('...and Cmd+Z reopens them all', (await s()).order.split(' ').sort().join(' '), 'Alpha Bravo Charlie Delta');

// Coming back to the tab after a while shows what changed elsewhere
await js(`$('#message').hide(); undoStack = []; finishRemovals();
  tasksLoaded = true; auth.token = function() { return 'test'; }; $('#cards .list-title').first().val('Test');
  window.answerGet = function(path) {
    if (path.indexOf('users/@me/lists') === 0) return { items: [{ id: 'L1', title: 'Test, renamed elsewhere' }, { id: 'L2', title: 'Other' }] };
    if (path.indexOf('lists/L1/tasks') === 0 && path.indexOf('showCompleted=false') > 0) return { items: [
      { id: 'k1', title: 'Alpha, changed elsewhere', position: '1' }, { id: 'k2', title: 'Bravo', position: '2' }] };
    if (path.indexOf('lists/L2/tasks') === 0) return { items: [] };
  };
  document.activeElement.blur(); window.dispatchEvent(new Event('blur')); true`);
await wait(3300);
await js(`window.dispatchEvent(new Event('focus')); true`);
await wait(800);
check('coming back reloads the lists and their tasks', [await js(`$('#cards .list-title').map(function() { return this.value; }).get()`), (await s()).order],
  [['Test, renamed elsewhere', 'Other'], 'Alpha, changed elsewhere Bravo']);
await js(`window.answerGet = null; true`);

// ---- The keyboard shortcuts
await js(`document.activeElement.blur(); true`);
await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: '?', code: 'Slash', text: '?', modifiers: 8 });
await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: '?', code: 'Slash', modifiers: 8 });
await wait(100);
check('? opens the keyboard shortcuts', await js(`$('#shortcuts').prop('open') && $('#shortcuts kbd').length > 20`), true);
await key('Escape');
check('Escape closes them', await js(`$('#shortcuts').prop('open')`), false);
await caretIn('Alpha, changed elsewhere', -1);
await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: '?', code: 'Slash', text: '?', modifiers: 8 });
await wait(100);
check('...but ? while typing is just a question mark', [await js(`$('#shortcuts').prop('open')`), await js(`document.activeElement.value`)], [false, 'Alpha, changed elsewhere?']);

// ---- Search
await reset([{ id: 's1', title: 'Alpha', position: '1' }, { id: 's2', title: 'Bravo', position: '2' },
  { id: 's3', title: 'Buy milk', parent: 's2', position: '1' }, { id: 's4', title: 'Bake bread', parent: 's2', position: '2' },
  { id: 's5', title: 'Charlie', position: '3', notes: 'Oat milk, not cow' }, { id: 's6', title: 'Delta', position: '4' }]);
await js(`$('#message').hide(); document.activeElement.blur(); $('body').addClass('signed-in'); true`);
const visible = () => js(`$('#cards .card').first().find('.claire > li:not(.no-match)').map(function() { return ($(this).hasClass('subtask') ? '-' : '') + $(this).children('.todo').val(); }).get().join(' ')`);
await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', text: '/' });
await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash' });
await wait(80);
check('/ goes to the search box', await js(`document.activeElement === $('#search input')[0]`), true);
await type('milk'); await wait(300);
check('only matching tasks show; a matching subtask keeps its task; notes count', await visible(), 'Bravo -Buy milk Charlie');
check('...and how many is said', await js(`$('#announce').text()`), '3 tasks match');
await type(' oat'); await wait(300);
check('every word has to match', await visible(), 'Charlie');
await key('Enter');
check('Enter goes to the first match', (await s()).focus, 'TEXTAREA:Charlie');
await key('Tab');
check('moving waits for the search to be cleared', [await visible(), await js(`$('#message').text().trim()`)], ['Charlie', 'Clear the search to move or indent tasks.']);
await js(`$('#search input').val('a'); applySearch(); true`);
await caretIn('Alpha', -1);
await key('ArrowDown', ['shift']);
check('picking skips hidden tasks', [await visible(), (await s()).picked], ['Alpha Bravo -Bake bread Charlie Delta', 'Alpha Bravo']);
await key('Escape');
await js(`$('#search input').focus().val('zebra'); applySearch(); true`);
check('a list with no matches says so', [await visible(), await js(`$('#cards .card').first().find('.no-matches').is(':visible')`)], ['', true]);
await key('Escape');
check('Escape clears the search and shows everything', [await visible(), await js(`$('#search input').val()`)], ['Alpha Bravo -Buy milk -Bake bread Charlie Delta', '']);

// ---- What screen readers are told
await reset([{ id: 'r1', title: 'Plan the party', position: '1' }, { id: 'r2', title: 'Order the cake', position: '2', due: dayIso(1) },
  { id: 'r3', title: 'Send the invites', position: '3' }]);
const said = () => js(`$('#announce').text()`);
await js(`pickHinted = false; true`); // as if picking for the first time
check('each tick circle and menu names its task', await js(`[$(${rowOf('Order the cake')}).children('input').attr('aria-label'), $(${rowOf('Order the cake')}).children('.more').attr('aria-label')]`),
  ['Complete Order the cake', 'Options for Order the cake']);
check('the date and notes are read with the task', await js(`$('#' + $(${rowOf('Order the cake')}).children('.todo').attr('aria-describedby')).text()`), 'Tomorrow');
check('the Tomorrow chip says it is on', await js(`[$(${rowOf('Order the cake')}).find('[data-due=1]').attr('aria-pressed'), $(${rowOf('Order the cake')}).find('[data-due=0]').attr('aria-pressed')]`), ['true', 'false']);
check('the list is named', await js(`$('#cards .claire').first().attr('aria-label')`), await js(`$('#cards .list-title').first().val()`));
await caretIn('Order the cake', -1);
await key('Tab'); await wait(120);
check('Tab is announced', [await said(), await js(`$(${rowOf('Order the cake')}).children('.todo').attr('aria-label')`)], ['Subtask of Plan the party', 'Subtask']);
await key('Tab', ['shift']); await wait(120);
check('Shift+Tab is announced', await said(), 'Moved out, not a subtask');
await key('ArrowDown', ['alt']); await wait(120);
check('Alt+Down is announced', await said(), 'Moved down');
await caretIn('Plan the party', -1);
await key('ArrowDown', ['shift']); await wait(120);
check('picking is announced, with the keys the first time', await said(), '2 tasks picked. Backspace deletes them, ' + (process.platform === 'darwin' ? 'Command' : 'Control') + ' Enter ticks them, Escape goes back.');
await key('ArrowDown', ['shift']); await wait(120);
check('...and then just the count', await said(), '3 tasks picked');
await key('Escape');
await js(`$(${rowOf('Plan the party')}).children('input').prop('checked', true).trigger('change'); true`); await wait(100);
check('a ticked task offers to reopen', await js(`$('.todo').filter(function() { return this.value === 'Plan the party'; }).siblings('input').attr('aria-label')`), 'Reopen Plan the party');

// ---- Phones and tablets: holding and tapping to pick, the bar, and dragging by touch
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await reset([{ id: 'u1', title: 'Alpha', position: '1' }, { id: 'u2', title: 'Bravo', position: '2' },
  { id: 'u3', title: 'Charlie', position: '3' }, { id: 'u4', title: 'Delta', position: '4' }]);
await js(`$('#message').hide(); document.activeElement.blur(); true`);
check('a touch screen counts as one', await js(`matchMedia('(pointer: coarse)').matches`), true);
const touch = async (type, x, y) => { await cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] }); await wait(30); };
const tap = async (x, y) => { await touch('touchStart', x, y); await touch('touchEnd'); await wait(120); };
const hold = async (x, y) => { await touch('touchStart', x, y); await wait(650); await touch('touchEnd'); await wait(150); };
const at = async title => (await box(`$(${rowOf(title)}).children('.todo')[0]`)).slice(0, 2);
const bar = () => js(`$('#pick-bar').is(':visible') ? $('#pick-bar .count').text() : 'hidden'`);
await hold(...await at('Bravo'));
check('holding a task picks it, with the bar, and no keyboard', [(await s()).picked, await bar(), (await s()).focus], ['Bravo', '1 selected', 'UL']);
await tap(...await at('Delta'));
check('a tap adds another', [(await s()).picked, await bar()], ['Bravo Delta', '2 selected']);
await tap(...await at('Bravo'));
check('a tap on a picked one takes it away', (await s()).picked, 'Delta');
await tap(...await at('Charlie'));
await tap(...await box(`$('#pick-bar [data-pick=tick]')[0]`).then(b => b.slice(0, 2)));
await wait(200);
check('Tick in the bar ticks them all, and the bar goes', [(await s()).order, await bar(), (await s()).picked], ['Alpha Bravo', 'hidden', '']);
await key('z', ['meta']); await wait(200);
check('...and undo brings them back', (await s()).order.split(' ').sort().join(' '), 'Alpha Bravo Charlie Delta');
await js(`$('#message').hide(); true`);
await tap(...await box(`$(${rowOf('Alpha')}).children('.more')[0]`).then(b => b.slice(0, 2)));
check('Select is in the menu on a touch screen', await js(`$(${rowOf('Alpha')}).find('[data-move=select]').is(':visible')`), true);
await tap(...await box(`$(${rowOf('Alpha')}).find('[data-move=select]')[0]`).then(b => b.slice(0, 2)));
check('...and picks the task', [(await s()).picked, await bar()], ['Alpha', '1 selected']);
await tap(...await box(`$('#pick-bar [data-pick=done]')[0]`).then(b => b.slice(0, 2)));
check('Done stops picking', [(await s()).picked, await bar()], ['', 'hidden']);
const before = (await s()).order.split(' ').filter(x => x !== 'Alpha');
before.splice(before.indexOf('Charlie') + 1, 0, 'Alpha'); // where it should land
const h = await box(`$(${rowOf('Alpha')}).children('.handle')[0]`), below = await box(rowOf('Charlie'));
await touch('touchStart', h[0], h[1]);
for (const y of [h[1] + 15, (h[1] + below[3]) / 2, below[3] - 3]) await touch('touchMove', h[0], y);
await touch('touchEnd'); await wait(200);
check('dragging by the handle with a finger moves the task', (await s()).order, before.join(' '));
await cdp('Emulation.setTouchEmulationEnabled', { enabled: false });

// ---- The website's sign-in is renewed on a key press near the end of its hour.
// Last, as it loads the page again. Google's script is replaced by a fake.
// (Marked as logged out, so the page doesn't try the made-up token on Google as it loads.)
await js(`sessionStorage.setItem('tabandtick-token', JSON.stringify({ token: 'old', until: Date.now() + 60000 }));
  localStorage.setItem('tabandtick-logged-out', '1'); true`);
await cdp('Page.navigate', { url: base + 'index.html' });
await wait(1500);
await js(`window.calls = [];
  window.google = { accounts: { oauth2: {
    hasGrantedAllScopes: function() { return true; },
    initTokenClient: function(config) {
      calls.push('hint:' + config.hint);
      return { requestAccessToken: function(options) { calls.push('prompt:' + options.prompt); config.callback({ access_token: 'new', expires_in: 3600 }); } };
    } } } };
  localStorage.removeItem('tabandtick-logged-out'); auth.hint('alex@example.com'); true`);
await key('Escape');
check('a key in the last minutes renews the sign-in, for the same account, without asking', [await js('calls'), await js('auth.token()')],
  [['hint:alex@example.com', 'prompt:'], 'new']);
await key('Escape');
check('...and not again while the new one is fresh', await js('calls.length'), 2);

const errors = await js(`window.__errors || []`);
check('no errors in the page', pageErrors.slice(0, 3), []);
console.log(failures ? failures + ' failed' : 'all passed');
ws.close(); chrome.kill(); server.close();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(failures ? 1 : 0);
