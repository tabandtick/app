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

// A row only gets a tick box once it has a title.
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

function deleteAndMoveOn(todo) {
	if (hasOpenSubtasks(todo)) return;
	var rows = todo.parent().add(subtaskRows(todo));
	var row = rows.last().nextAll('li').first();
	if (!row.length) row = rows.first().prev();
	var following = row.children('.todo');
	removeRow(todo);
	selected = $();
	// Ready to delete the next one. Caret at the end, so Backspace edits its text.
	if (following.length) following.setCursorPosition(following.val().length);
}

// Split a row in two. The new one goes below any subtasks, as it does in Google.
function splitRow(todo) {
	var position = todo[0].selectionStart, title = todo.val();
	var below = subtaskRows(todo).last();
	var row = taskRow({ parent: todo[0].parentTask }, todo[0].card);
	var added = row.children('.todo').val(title.slice(position));
	(below.length ? below : todo.parent()).after(row);
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

	// Tab at the start indents, and Shift+Tab moves out; anywhere else, or if it
	// can't be done, they move focus as usual. So they do in a row reached by Tab.
	if (code === 9) {
		if (position !== 0 || !caret || command || event.altKey || el.tabbedTo) return;
		var pressed = tabbing;
		tabbing = false; // moving the row focuses it again, which isn't reaching it by Tab
		if (moveRow(todo, event.shiftKey ? 'outdent' : 'indent')) event.preventDefault();
		else tabbing = pressed;
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

function toggleDetails(row) {
	row.toggleClass('open');
	if (row.hasClass('open')) row.find('.notes').focus();
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
	$('.menu-open').removeClass('menu-open').children('.more').attr('aria-expanded', 'false');
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
	if (drag.rows.length > 1 || other) while (i < rows.length && rows.eq(i).hasClass('subtask')) i++; // stay out of another family
	var above = rows.eq(i - 1), below = rows.eq(i);
	if (i === 0) above = $();
	var level = drag.level + (dx > 24 ? 1 : dx < -24 ? -1 : 0);
	if (below.hasClass('subtask')) level = 1; // between a task and its subtasks
	if (drag.rows.length > 1 || !above.length || other) level = 0;
	var todo = above.children('.todo');
	var parent = level > 0 ? (above.hasClass('subtask') ? todo[0].parentTask : todo.attr('id')) : undefined;
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
	var left = place.left + (place.parent ? 44 : 0);
	$('#drop-line').css({ top: place.top - 1, left: left, width: place.right - left }).show();
}

function dragEnd(event) {
	if (!drag) return;
	var d = drag;
	drag = null;
	$('#drop-line').hide();
	d.rows.removeClass('dragging');
	if (!event || event.type !== 'pointerup' || !d.place || !$.contains(document, d.todo[0])) return;
	if (d.place.other) moveToList(d.todo, d.place.card[0].list, d.place.after);
	else place(d.todo, d.place.below, d.place.parent);
}

document.addEventListener('pointerdown', function(event) {
	var handle = $(event.target).closest('.claire .handle');
	if (!handle.length || event.button || drag || handle.siblings('.todo').hasClass('checked')) return;
	event.preventDefault(); // no text selection
	var row = handle.parent(), todo = row.children('.todo');
	drag = { todo: todo, card: todo[0].card, rows: row.add(subtaskRows(todo)), x: event.clientX, y: event.clientY, level: row.hasClass('subtask') ? 1 : 0 };
});
document.addEventListener('pointermove', dragMove);
document.addEventListener('pointerup', dragEnd);
document.addEventListener('pointercancel', dragEnd);
document.addEventListener('keydown', function(event) {
	if (event.key !== 'Escape') return;
	dragEnd();
	closeMenu();
});

$(document).ready(function() {

	$('#cards')
		.on('keydown', '.todo', keydown)
		.on('focusin', 'ul.list li', function() {
			$('li.selected').removeClass('selected');
			selected = $(this).addClass('selected').children('.todo');
			if (selected[0]) selected[0].tabbedTo = tabbing;
			if (selected.val()) selected[0].lastTitle = selected.val(); // for undo, if it's then cleared
		})
		.on('focusout', '.todo, .notes, .due', function() { saveTask($(this).closest('li').children('.todo')); })
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
		.on('change', 'ul.list input[type=checkbox]', function() { setCompleted($(this)); })
		.on('click', '.more', function() {
			var row = $(this).parent(), open = row.hasClass('menu-open'); // a task, or a card's heading
			closeMenu();
			if (!open) openMenu(row);
		})
		.on('click', '.meta', function() { toggleDetails($(this).parent()); })
		.on('click', '.clear-due', function() {
			var row = $(this).closest('li');
			row.find('.due').val('');
			renderMeta(row);
			saveTask(row.children('.todo'));
		});

	$('#cards').on('click', 'ul.list [data-move]', function() {
		var row = $(this).closest('li'), todo = row.children('.todo'), how = $(this).attr('data-move');
		closeMenu();
		if (how === 'details') toggleDetails(row);
		else if (how === 'delete') deleteAndMoveOn(todo);
		else moveRow(todo, how);
	}).on('click', '[data-to]', function() {
		var todo = $(this).closest('li').children('.todo'), to = $(this).attr('data-to');
		closeMenu();
		moveToList(todo, to);
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
		if (!$(event.target).closest('.menu, .more').length) closeMenu();
	});
	$('#authorize-button').click(handleAuthClick);
	$('#lists').on('change', 'input', function() { showList($(this).attr('data-list'), this.checked); });
	$('#all-lists').click(showAllLists);
	$('#side-toggle').click(function() { $('body').toggleClass('side-open'); });
	$('#create').click(function() {
		$('body').removeClass('side-open');
		newTask(currentCard());
	});
	$('#new-list').click(askNewList);
	$('#dialog .cancel').click(function() { $('#dialog')[0].close(); });
	$('#log-out-button').click(logOut);
	// Cmd+Z, unless it should undo typing
	document.addEventListener('keydown', function(event) {
		if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
		var field = $(event.target).is('input:not([type=checkbox]), textarea');
		if (field && (typed || !$(event.target).closest('ul.list').length)) return;
		if (undoLast()) event.preventDefault();
	});

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
