// The task count, buttons and keys. tasks.js does everything that talks to Google.

$.fn.setCursorPosition = function(start, end) {
    if(!end) end = start;
    return this.each(function() {
        if (this.setSelectionRange) {
            this.focus();
            this.setSelectionRange(start, end);
        } else if (this.createTextRange) {
            var range = this.createTextRange();
            range.collapse(true);
            range.moveEnd('character', end);
            range.moveStart('character', start);
            range.select();
        }
    });
};

function updateToDoCount() {
	$('#cards .card').each(function() {
		var card = $(this), list = findList(this.list);
		if (!this.loaded || !list) return;
		card.find('.empty').toggle(!card.find('.claire li').length);
		list.count = card.find('.claire .todo').not('.checked').filter(function() { return this.value.length > 0; }).length;
		showCount(list);
	});
}

// A row can only be dragged once it has a title.
function toggleToDoCheckboxes() {
	$('.todo').each(function() {
		$(this).parent().toggleClass('unhide', this.value.length > 0);
	});
}

var selected = $();
var tabbing = false;

// The card last used, for the Create button.
function currentCard() {
	var card = selected.closest('.card');
	return card.length ? card : $('#cards .card').first();
}

// Delete one task or several, and their subtasks, and go to the row after them.
function deleteAndMoveOn(todos) {
	if (todos.toArray().some(function(el) { return hasOpenSubtasks($(el)); })) return;
	var rows = todos.parent();
	todos.each(function() { rows = rows.add(subtaskRows($(this))); });
	var row = rows.last().nextAll('li').not(rows).first();
	if (!row.length) row = rows.first().prevAll('li').not(rows).first();
	var following = row.children('.todo');
	removeRow(todos);
	selected = $();
	// Ready to delete the next one. Caret at the end, so Backspace edits its text.
	if (following.length) following.setCursorPosition(following.val().length);
}

// A new task left blank goes when you leave it, as in Google Tasks. Not when its
// notes or menu are opened, another window is used, or rows are being picked.
function dropIfBlank(el) {
	var todo = $(el), row = todo.parent();
	if (!$.contains(document, el) || el.deleted || el.id || el.saving || !document.hasFocus()) return;
	if (row.has(document.activeElement).length || (picked && picked.list === row.parent()[0])) return;
	var values = current(todo);
	if (values.title || values.notes || values.due || subtaskRows(todo).length) return;
	if (selected[0] === el) selected = $();
	row.remove();
	refreshRows();
}

// Any left behind while rows were picked
function dropBlanks() {
	$('.claire .todo:not([id])').each(function() { dropIfBlank(this); });
}

// Split a row in two. If the task has subtasks, the new one is the first of them.
function splitRow(todo) {
	var position = todo[0].selectionStart, title = todo.val();
	var parent = subtaskRows(todo).length ? taskKey(todo[0]) : todo[0].parentTask;
	var row = taskRow({ parent: parent }, todo[0].card);
	var added = row.children('.todo').val(title.slice(position));
	todo.parent().after(row);
	todo.val(title.slice(0, position));
	refreshRows();
	added.setCursorPosition(0);
	saveSoon(todo);
	saveSoon(added);
	canUndo(function() { return live(todo).length && live(added).length; }, function() { mergeRows(live(todo), live(added)); });
}

function keydown(event) {
	if (event.originalEvent && event.originalEvent.isComposing) return;
	var todo = $(event.currentTarget), el = todo[0], row = todo.parent();
	var position = el.selectionStart, length = todo.val().length;
	var caret = el.selectionEnd === position; // nothing selected
	var modified = event.shiftKey || event.metaKey || event.altKey || event.ctrlKey;
	var completed = row.parent().is('.done-list');
	var previous = row.prev().children('.todo'), next = row.next().children('.todo');
	var wrapped = el.clientHeight > 1.5 * parseFloat($(el).css('line-height'));

	var code = event.which || event.keyCode;
	var command = event.metaKey || event.ctrlKey;
	var how = event.altKey && !command ? { 38: 'up', 40: 'down' }[code]
		: command && !event.altKey && !event.shiftKey ? { 221: 'indent', 219: 'outdent' }[code] : null;
	if (how) {
		event.preventDefault();
		moveRow(todo, how);
		return;
	}

	// Tab indents and Shift+Tab moves out, wherever the caret is. If that can't be
	// done, or the row was reached by Tab, they move focus as usual.
	if (code === 9) {
		if (command || event.altKey || el.tabbedTo) return;
		var pressed = tabbing;
		tabbing = false; // moving the row focuses it again, which isn't reaching it by Tab
		if (moveRow(todo, event.shiftKey ? 'outdent' : 'indent')) event.preventDefault();
		else tabbing = pressed;
		return;
	}

	// Shift+Up/Down picks rows, once the caret can't go further in a wrapped title
	if (event.shiftKey && !command && !event.altKey && (code === 38 || code === 40)) {
		var down = code === 40;
		if (wrapped && (down ? el.selectionEnd !== length : el.selectionStart !== 0)) return;
		event.preventDefault();
		startPicking(row, down ? 1 : -1);
		return;
	}

	switch (code) {

		case 13: //enter
			event.preventDefault();
			if (completed) todo.blur();
			else splitRow(todo);
		break;

		case 8: //backspace
			if (position !== 0 || !caret) break;
			if (previous.length) {
				event.preventDefault();
				mergeRows(previous, todo);
			}
			else if (!length && (next.length || el.id)) {
				event.preventDefault();
				// If its subtasks go too, the next row is the one after them
				next = row.nextAll('li').not(subtaskRows(todo)).first().children('.todo');
				removeBlank(todo, next, 0);
			}
		break;

		case 46: //delete
			if (position !== length || !caret || !next.length) break;
			event.preventDefault();
			mergeRows(todo, next);
		break;

		case 40: //down arrow
			if (modified || !next.length || (wrapped && position !== length)) break;
			event.preventDefault();
			next.setCursorPosition(position);
		break;

		case 38: //up arrow
			if (modified || !previous.length || (wrapped && position !== 0)) break;
			event.preventDefault();
			previous.setCursorPosition(position);
		break;
	}
}

// ---- Several rows, picked with Shift+Up/Down, Shift+click or Cmd+click. Focus
// moves to their list, so typing can't change a title. Picked rows can be deleted,
// moved, indented and copied together; anything else goes back to editing.

// { list, base, anchor, head }: the list's element, rows picked one at a time with
// Cmd+click, and the rows a range runs between, if there is one
var picked = null;

// The picked rows, in order, without stopping if there are none.
function pickedSet() {
	if (!picked) return $();
	var rows = $(picked.list).children('li');
	var a = rows.index(picked.anchor), b = rows.index(picked.head);
	if (a < 0 || b < 0) picked.anchor = picked.head = null; // refreshed, or moved away
	var range = picked.anchor ? rows.slice(Math.min(a, b), Math.max(a, b) + 1) : $();
	return rows.filter(function() { return $.inArray(this, picked.base) >= 0; }).add(range);
}

function pickedRows() {
	var rows = pickedSet();
	if (picked && !rows.length) stopPicking();
	return rows;
}

function showPicked() {
	$('li.picked').removeClass('picked');
	pickedRows().addClass('picked');
	if (picked && picked.head) picked.head.scrollIntoView({ block: 'nearest' });
}

function startPicking(row, by) {
	var head = by > 0 ? row.next('li') : row.prev('li');
	picked = { list: row.parent()[0], base: [], anchor: row[0], head: head[0] || row[0] };
	$('li.selected').removeClass('selected');
	$(picked.list).attr('tabindex', '-1')[0].focus({ preventScroll: true });
	showPicked();
}

// Shift+Up/Down moves the end of the range, or starts one from the last row picked.
function extendPicking(by) {
	var rows = pickedRows();
	if (!picked.head) picked.anchor = picked.head = (by > 0 ? rows.last() : rows.first())[0];
	var next = by > 0 ? $(picked.head).next('li') : $(picked.head).prev('li');
	if (next.length) picked.head = next[0];
	showPicked();
}

// Stop, and put the caret at the 'start' or end of a row, if one is given.
function stopPicking(row, where) {
	picked = null;
	setTimeout(dropBlanks); // once focus has landed
	$('li.picked').removeClass('picked');
	var todo = row && row.children('.todo');
	if (todo && todo.length) todo.setCursorPosition(where === 'start' ? 0 : todo.val().length);
}

// The picked tasks that aren't subtasks of another picked one, which they move with.
function pickedTops() {
	var todos = pickedRows().children('.todo');
	var ids = todos.map(function() { return taskKey(this); }).get();
	return todos.filter(function() { return $.inArray(this.parentTask, ids) < 0; });
}

function movePicked(how) {
	var todos = pickedTops().get();
	if (how === 'down' || how === 'top') todos.reverse(); // the bottom one makes room first
	asOneUndo(function() {
		$.each(todos, function(i, el) {
			var row = $(el).parent(), at = row.index();
			moveRow($(el), how);
			return row.index() !== at; // stop at the top or bottom
		});
	});
	refocusPicked();
}

// Back to the list after a menu or a drag, which took focus or might have.
function refocusPicked() {
	if (picked) picked.list.focus({ preventScroll: true });
	showPicked();
}

function indentPicked(how) {
	var todos = pickedRows().children('.todo').get();
	if (how === 'outdent') todos.reverse(); // each goes after its family, so the bottom one first
	asOneUndo(function() {
		$.each(todos, function(i, el) { moveRow($(el), how); });
	});
	refocusPicked();
}

function movePickedToList(id) {
	var todos = pickedTops();
	stopPicking();
	moveToList(todos, id);
}

// Whether a row is one of several picked, so its menu and handle act on them all.
function isPicked(row) {
	return pickedRows().length > 1 && row.hasClass('picked');
}

function deletePicked() {
	var todos = pickedRows().children('.todo');
	picked = null; // deleting moves on to the next row
	$('li.picked').removeClass('picked');
	if (todos.length) deleteAndMoveOn(todos);
}

function pickingKey(event) {
	if (!picked || event.target !== picked.list || event.defaultPrevented) return;
	var code = event.which, command = event.metaKey || event.ctrlKey;
	var rows = pickedRows();
	if (!rows.length) return;
	var head = picked.head ? $(picked.head) : rows.last();
	var arrow = code === 38 || code === 40;
	if (/^(Shift|Meta|Control|Alt)$/.test(event.key)) return;
	if (command && /^[cxz]$/i.test(event.key) && !event.altKey) { // copy, cut, undo
		if (event.key.toLowerCase() === 'z') stopPicking();
		return;
	}
	event.preventDefault();
	if (arrow && event.shiftKey && !command && !event.altKey) extendPicking(code === 40 ? 1 : -1);
	else if (arrow && event.altKey && !command) movePicked(code === 38 ? 'up' : 'down');
	else if (code === 9 && !command && !event.altKey) indentPicked(event.shiftKey ? 'outdent' : 'indent');
	else if (command && !event.altKey && (code === 221 || code === 219)) indentPicked(code === 221 ? 'indent' : 'outdent');
	else if ((code === 8 || code === 46) && !command && !event.altKey) deletePicked();
	else if (code === 38) stopPicking(rows.first(), 'start');
	else if (code === 40) stopPicking(rows.last(), 'end');
	else stopPicking(head, 'end');
}

var mac = /Mac|iPhone|iPad/.test(navigator.platform);

// Shift+click picks from the row being edited, or the last one picked, to this one.
// Cmd+click (Ctrl+click elsewhere) adds a row, or takes it away.
function clickPick(event) {
	var command = mac ? event.metaKey : event.ctrlKey;
	if (event.button || event.altKey || event.shiftKey === command || (mac && event.ctrlKey)) return;
	var target = $(event.target);
	var row = target.closest('ul.list > li');
	if (!row.length || target.closest('input[type=checkbox], .handle, .more, .menu, .details').length) return;
	var list = row.parent()[0];
	event.preventDefault(); // no caret or text selection
	if (!picked || picked.list !== list) {
		var editing = $(document.activeElement).closest('ul.list > li').filter(function() { return this.parentNode === list; })[0];
		picked = { list: list, base: [], anchor: editing || null, head: editing || null };
	}
	if (event.shiftKey) {
		if (!picked.anchor) picked.anchor = row[0];
		picked.head = row[0];
	} else {
		var base = pickedSet().get(), at = $.inArray(row[0], base);
		if (at >= 0) base.splice(at, 1);
		else base.push(row[0]);
		picked.base = base;
		picked.anchor = picked.head = at >= 0 ? null : row[0]; // a range would start from here
		if (!base.length) return stopPicking();
	}
	$('li.selected').removeClass('selected');
	$(list).attr('tabindex', '-1');
	refocusPicked();
}

// Copying gives the titles, one to a line.
function copyPicked(event) {
	if (!picked || document.activeElement !== picked.list) return;
	var titles = pickedRows().children('.todo').map(function() { return this.value; }).get();
	event.clipboardData.setData('text/plain', titles.join('\n'));
	event.preventDefault();
	if (event.type === 'cut') deletePicked();
}

// The details show while a task is being edited, so going to its notes shows them.
function openDetails(row) {
	var notes = row.find('.notes');
	notes.setCursorPosition(notes.val().length);
	autosize(notes);
}

function openMenu(row) {
	row.addClass('menu-open').children('.more').attr('aria-expanded', 'true');
	var menu = row.children('.menu').removeClass('up');
	menu.children('[data-to]').remove();
	var todo = row.children('.todo');
	if (todo[0] && row.parent().is('.claire') && !todo.hasClass('checked')) {
		menu.children('[data-move=delete]').before($.map(lists, function(list) {
			if (list.id === todo[0].card[0].list) return null;
			return $('<button type="button" role="menuitem"></button>').attr('data-to', list.id).text('Move to ' + list.title);
		}));
	}
	if (menu[0].getBoundingClientRect().bottom > window.innerHeight) menu.addClass('up');
}

function closeMenu() {
	$('.menu-open').removeClass('menu-open').children('.more, #account-button').attr('aria-expanded', 'false');
}

// A dialog with a title, some text, perhaps a field, and Cancel. Calls done with the
// field's value.
function ask(options, done) {
	var dialog = $('#dialog'), field = dialog.find('input'), button = dialog.find('.ok');
	dialog.find('h2').text(options.title);
	dialog.find('p').text(options.text || '').toggle(!!options.text);
	field.toggle(options.field !== undefined).val(options.field || '').attr('placeholder', options.placeholder || '');
	button.text(options.button).toggleClass('danger', !!options.danger);
	function ready() { button.prop('disabled', options.field !== undefined && !$.trim(field.val())); }
	field.off('input').on('input', ready);
	ready();
	dialog.find('form').off('submit').on('submit', function(event) {
		event.preventDefault();
		dialog[0].close();
		done($.trim(field.val()));
	});
	dialog[0].showModal();
	if (options.field !== undefined) field.focus().select();
	else dialog.find('.cancel').focus();
}

function askNewList() {
	ask({ title: 'New list', field: '', placeholder: 'Name', button: 'Create' }, createList);
}

// ---- Dragging. A line shows where the row will land; moving right or left makes
// it a subtask or not. Nothing moves until it is dropped.

var drag = null;

function dropPlace(x, y, dx) {
	var card = $('#cards .card').filter(function() {
		var box = this.getBoundingClientRect();
		return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
	});
	if (!card.length || !card[0].loaded) card = drag.card;
	var other = !card.is(drag.card);
	var rows = card.find('.claire li').not(drag.rows);
	var i = rows.filter(function() {
		var box = this.getBoundingClientRect();
		return box.top + box.height / 2 < y;
	}).length;
	if (drag.family || other) while (i < rows.length && rows.eq(i).hasClass('subtask')) i++; // stay out of another family
	var above = rows.eq(i - 1), below = rows.eq(i);
	if (i === 0) above = $();
	var level = drag.level + (dx > 24 ? 1 : dx < -24 ? -1 : 0);
	if (below.hasClass('subtask')) level = 1; // between a task and its subtasks
	if (drag.family || !above.length || other) level = 0;
	var todo = above.children('.todo');
	var parent = level > 0 ? (above.hasClass('subtask') ? todo[0].parentTask : taskKey(todo[0])) : undefined;
	var list = card.find('.claire')[0].getBoundingClientRect();
	var box = below[0] || above[0] ? (below[0] || above[0]).getBoundingClientRect() : list;
	// The task it goes after in another list: the nearest open one that isn't a subtask
	var after = above.add(above.prevAll()).not('.subtask').children('.todo[id]').not('.checked').last().attr('id');
	return { card: card, other: other, below: below, parent: parent, after: after, top: below.length || !above.length ? box.top : box.bottom, left: list.left, right: list.right };
}

function dragMove(event) {
	if (!drag) return;
	if (!drag.moved && Math.abs(event.clientY - drag.y) < 5 && Math.abs(event.clientX - drag.x) < 5) return;
	drag.moved = true;
	event.preventDefault();
	drag.rows.addClass('dragging');
	if (event.clientY < 60) window.scrollBy(0, -12);
	if (event.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
	var place = drag.place = dropPlace(event.clientX, event.clientY, event.clientX - drag.x);
	var left = place.left + (place.parent ? 34 : 0);
	$('#drop-line').css({ top: place.top - 1, left: left, width: place.right - left }).show();
}

function dragEnd(event) {
	if (!drag) return;
	var d = drag;
	drag = null;
	$('#drop-line').hide();
	d.rows.removeClass('dragging');
	if (!event || event.type !== 'pointerup' || !d.place || !$.contains(document, d.todo[0])) return;
	if (d.picked) {
		if (d.place.other) {
			stopPicking();
			moveToList(d.picked, d.place.card[0].list, d.place.after);
		} else {
			asOneUndo(function() {
				d.picked.each(function() { place($(this), d.place.below, d.place.parent); });
			});
			refocusPicked();
		}
	}
	else if (d.place.other) moveToList(d.todo, d.place.card[0].list, d.place.after);
	else place(d.todo, d.place.below, d.place.parent);
}

document.addEventListener('pointerdown', function(event) {
	var handle = $(event.target).closest('.claire .handle');
	if (!handle.length || event.button || drag || handle.siblings('.todo').hasClass('checked')) return;
	event.preventDefault(); // no text selection
	var row = handle.parent(), todo = row.children('.todo');
	drag = { todo: todo, card: todo[0].card, rows: row.add(subtaskRows(todo)), x: event.clientX, y: event.clientY, level: row.hasClass('subtask') ? 1 : 0 };
	if (isPicked(row)) { // all of them, and their subtasks
		drag.picked = pickedTops().not('.checked');
		drag.picked.each(function() { drag.rows = drag.rows.add($(this).parent()).add(subtaskRows($(this))); });
	}
	else if (picked) stopPicking();
	drag.family = drag.rows.length > (drag.picked ? drag.picked.length : 1); // a task with subtasks can't become one
});
document.addEventListener('pointermove', dragMove);
document.addEventListener('pointerup', dragEnd);
document.addEventListener('pointercancel', dragEnd);
document.addEventListener('keydown', function(event) {
	if (event.key !== 'Escape') return;
	dragEnd();
	closeMenu();
	if (picked && $(document.activeElement).closest('li.picked').length) refocusPicked(); // from its menu
	var details = $(document.activeElement).closest('ul.list li .details');
	if (details.length) { // back to the title
		var todo = details.siblings('.todo');
		todo.setCursorPosition(todo.val().length);
	}
});

$(document).ready(function() {

	$('#cards')
		.on('keydown', '.todo', keydown)
		.on('focusin', 'ul.list li', function(event) {
			if (picked && $(event.target).closest('.more, .menu').length && isPicked($(this))) return; // its menu
			if (picked) stopPicking();
			$('li.selected').removeClass('selected');
			selected = $(this).addClass('selected').children('.todo');
			if (selected[0]) selected[0].tabbedTo = tabbing;
			if (selected.val()) selected[0].lastTitle = selected.val(); // for undo, if it's then cleared
		})
		.on('focusout', '.todo, .notes, .due', function() { saveTask($(this).closest('li').children('.todo')); })
		.on('focusout', '.claire li', function(event) {
			var el = $(this).children('.todo')[0];
			if (el && !$(this).has(event.relatedTarget).length) setTimeout(function() { dropIfBlank(el); }); // once focus has landed
		})
		.on('focusout', 'ul.list', function(event) { // clicked elsewhere, not just another window
			if (!picked || event.target !== picked.list || !document.hasFocus()) return;
			var to = $(event.relatedTarget);
			if (to.closest('.more, .menu').length && isPicked(to.closest('li'))) return; // its menu
			stopPicking();
		})
		.on('input', '.todo', function() {
			autosize($(this));
			updateToDoCount();
			toggleToDoCheckboxes();
		})
		.on('paste', '.todo', function(event) {
			var data = event.originalEvent && event.originalEvent.clipboardData;
			var pasted = data && data.getData('text');
			if (!pasted || !/[\r\n]/.test(pasted)) return;
			event.preventDefault(); // a task is one line, unless Google already had more
			this.setRangeText(pasted.trim().replace(/\s*[\r\n]+\s*/g, ' '), this.selectionStart, this.selectionEnd, 'end');
			$(this).trigger('input');
		})
		.on('input', '.todo, .notes, .due', function() { typed = true; })
		.on('input change', '.todo, .notes, .due', function() {
			var row = $(this).closest('li');
			renderMeta(row);
			saveSoon(row.children('.todo'));
		})
		.on('change', 'ul.list input[type=checkbox]', function() {
			var todo = $(this).siblings('.todo');
			if (todo.attr('id') || todo.val() || todo[0].saving) return setCompleted($(this));
			// Never made at Google, so there's nothing to complete: it just goes
			todo[0].deleted = true; // removing it fires focusout, which mustn't save it
			todo.parent().remove();
			refreshRows();
		})
		.on('click', '.more', function() {
			var row = $(this).parent(), open = row.hasClass('menu-open'); // a task, or a card's heading
			closeMenu();
			if (!open) openMenu(row);
		})
		.on('click', '.meta', function() { openDetails($(this).parent()); })
		.on('focusin', 'ul.list li', function() { autosize($(this).find('.notes')); }) // shown now
		.on('input', '.notes', function() { autosize($(this)); })
		.on('click', '[data-due]', function() { // Today or Tomorrow, or off again
			var due = $(this).closest('li').find('.due'), day = dayFrom(+$(this).attr('data-due'));
			due.val(due.val() === day ? '' : day).trigger('change');
		})
		.on('click', '.pick-date', function() {
			var due = $(this).siblings('.due')[0];
			try { due.showPicker(); } catch (e) { due.focus(); }
		})
		.on('click', '.clear-due', function() {
			var row = $(this).closest('li'), todo = row.children('.todo');
			row.find('.due').val('').trigger('change');
			todo.setCursorPosition(todo.val().length); // the cross goes, and focus with it
		});

	$('#cards').on('click', 'ul.list [data-move]', function() {
		var row = $(this).closest('li'), todo = row.children('.todo'), how = $(this).attr('data-move');
		closeMenu();
		if (isPicked(row) && how === 'delete') deletePicked();
		else if (isPicked(row) && /^(up|down|top)$/.test(how)) movePicked(how);
		else if (isPicked(row) && /^(indent|outdent)$/.test(how)) indentPicked(how);
		else if (how === 'details') openDetails(row);
		else if (how === 'delete') deleteAndMoveOn(todo);
		else moveRow(todo, how);
	}).on('click', '[data-to]', function() {
		var row = $(this).closest('li'), to = $(this).attr('data-to');
		closeMenu();
		if (isPicked(row)) movePickedToList(to);
		else moveToList(row.children('.todo'), to);
	}).on('click', '[data-list-do]', function() {
		var card = $(this).closest('.card'), how = $(this).attr('data-list-do');
		closeMenu();
		if (how === 'rename') card.find('.list-title').focus().select();
		else if (how === 'hide') showList(card[0].list, false);
		else deleteList(card[0].list);
	}).on('click', '.new-task, .empty-new', function() {
		newTask($(this).closest('.card'));
	}).on('click', '.done-toggle', function() {
		toggleDone($(this).closest('.card'));
	}).on('click', '.done-more', function() {
		loadDone($(this).closest('.card'));
	}).on('change', '.list-title', function() {
		renameList($(this).closest('.card'), $.trim(this.value));
	}).on('keydown', '.list-title', function(event) {
		if (event.which === 13) this.blur();
		if (event.which === 27) {
			$(this).val((findList($(this).closest('.card')[0].list) || {}).title || '');
			this.blur();
		}
	});
	$(document).on('click', function(event) {
		if (!$(event.target).closest('.menu, .more, #account-button').length) closeMenu();
	});
	$('#authorize-button').click(handleAuthClick);
	$('#lists').on('change', 'input', function() { showList($(this).attr('data-list'), this.checked); });
	// The chevron by Lists folds them away, and they stay that way next time
	function foldLists(folded) {
		$('body').toggleClass('lists-folded', folded);
		$('#lists-toggle').attr('aria-expanded', String(!folded));
		try { localStorage.setItem('tabandtick-lists-folded', folded ? '1' : '0'); } catch (e) { /* storage is blocked */ }
	}
	try { if (localStorage.getItem('tabandtick-lists-folded') === '1') foldLists(true); } catch (e) { /* storage is blocked */ }
	$('#lists-toggle').click(function() { foldLists(!$('body').hasClass('lists-folded')); });
	// On a narrow screen the lists open over the page; on a wide one they hide, and
	// stay hidden next time.
	var narrow = window.matchMedia('(max-width: 960px)');
	function sideShown() {
		return narrow.matches ? $('body').hasClass('side-open') : !$('body').hasClass('side-closed');
	}
	try { $('body').toggleClass('side-closed', localStorage.getItem('tabandtick-side-closed') === '1'); } catch (e) { /* storage is blocked */ }
	$('#side-toggle').attr('aria-expanded', String(sideShown())).click(function() {
		if (narrow.matches) $('body').toggleClass('side-open');
		else {
			var closed = !$('body').hasClass('side-closed');
			$('body').toggleClass('side-closed', closed);
			try { localStorage.setItem('tabandtick-side-closed', closed ? '1' : '0'); } catch (e) { /* storage is blocked */ }
		}
		$(this).attr('aria-expanded', String(sideShown()));
	});
	narrow.addEventListener('change', function() { $('#side-toggle').attr('aria-expanded', String(sideShown())); });
	$('#create').click(function() {
		$('body').removeClass('side-open');
		newTask(currentCard());
	});
	$('#new-list').click(askNewList);
	$('#dialog .cancel').click(function() { $('#dialog')[0].close(); });
	$('#log-out-button').click(function() {
		closeMenu();
		logOut();
	});
	$('#account-button').click(function() {
		var account = $('#account'), open = account.hasClass('menu-open');
		closeMenu();
		account.toggleClass('menu-open', !open);
		$(this).attr('aria-expanded', String(!open));
	});
	// Cmd+Z, unless it should undo typing
	document.addEventListener('keydown', function(event) {
		if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
		var field = $(event.target).is('input:not([type=checkbox]), textarea');
		if (field && (typed || !$(event.target).closest('ul.list').length)) return;
		if (undoLast()) event.preventDefault();
	});

	document.addEventListener('pointerdown', clickPick, true);
	document.addEventListener('keydown', pickingKey);
	document.addEventListener('copy', copyPicked);
	document.addEventListener('cut', copyPicked);

	// Was focus moved here by the Tab key? Any other key or a click says no.
	document.addEventListener('keydown', function(event) {
		tabbing = event.key === 'Tab';
		if (!tabbing && event.key !== 'Shift' && event.target) event.target.tabbedTo = false;
	}, true);
	document.addEventListener('pointerdown', function(event) {
		tabbing = false;
		event.target.tabbedTo = false;
	}, true);
	$(window).on('resize', autosizeAll).on('scroll resize', loadMoreIfNear);

	updateToDoCount();
	checkAuth();

});
