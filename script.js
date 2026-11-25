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
	var count = $('#claire .todo').filter(function() { return this.value.length > 0; }).length;
	$('#total').text(tasksLoaded ? count : '');
	$('#empty').toggle(tasksLoaded && !$('#claire li').length);
	var list = currentList();
	if (list && tasksLoaded) {
		list.count = count;
		$('#lists [aria-current] .count').text(count);
	}
}

// A row only gets a tick box once it has a title.
function toggleToDoCheckboxes() {
	$('.todo').each(function() {
		$(this).parent().toggleClass('unhide', this.value.length > 0);
	});
}

var selected = $();

$('#new-task-button, #empty-new').click(function() { newTask(); });

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

$('#delete-task-button').click(function() {
	if (!selected.length || !$.contains(document, selected[0])) {
		showMessage('Click a task first, then Delete Task.', null, null, 4000);
		return;
	}
	deleteAndMoveOn(selected);
});

// Split a row in two. The new one goes below any subtasks, as it does in Google.
function splitRow(todo) {
	var position = todo[0].selectionStart, title = todo.val();
	var below = subtaskRows(todo).last();
	var row = taskRow({ parent: todo[0].parentTask });
	var added = row.children('.todo').val(title.slice(position));
	(below.length ? below : todo.parent()).after(row);
	todo.val(title.slice(0, position));
	refreshRows();
	added.setCursorPosition(0);
	saveSoon(todo);
	saveSoon(added);
}

function keydown(event) {
	if (event.originalEvent && event.originalEvent.isComposing) return;
	var todo = $(event.currentTarget), el = todo[0], row = todo.parent();
	var position = el.selectionStart, length = todo.val().length;
	var caret = el.selectionEnd === position; // nothing selected
	var modified = event.shiftKey || event.metaKey || event.altKey || event.ctrlKey;
	var completed = row.parent().is('#done-list');
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
			else if (!completed && !length && next.length) {
				event.preventDefault();
				var blank = row.find('.notes').val() === '' && row.find('.due').val() === '' && !subtaskRows(todo).length;
				if (blank) removeBlank(todo, next, 0);
				else {
					removeRow(todo);
					next.setCursorPosition(0);
				}
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
	if (menu[0].getBoundingClientRect().bottom > window.innerHeight) menu.addClass('up');
}

function closeMenu() {
	$('li.menu-open').removeClass('menu-open').children('.more').attr('aria-expanded', 'false');
}

// ---- Dragging. A line shows where the row will land; moving right or left makes
// it a subtask or not. Nothing moves until it is dropped.

var drag = null;

function dropPlace(y, dx) {
	var rows = $('#claire li').not(drag.rows);
	var i = rows.filter(function() {
		var box = this.getBoundingClientRect();
		return box.top + box.height / 2 < y;
	}).length;
	if (drag.rows.length > 1) while (i < rows.length && rows.eq(i).hasClass('subtask')) i++; // stay out of another family
	var above = rows.eq(i - 1), below = rows.eq(i);
	if (i === 0) above = $();
	var level = drag.level + (dx > 24 ? 1 : dx < -24 ? -1 : 0);
	if (below.hasClass('subtask')) level = 1; // between a task and its subtasks
	if (drag.rows.length > 1 || !above.length) level = 0;
	var todo = above.children('.todo');
	var parent = level > 0 ? (above.hasClass('subtask') ? todo[0].parentTask : todo.attr('id')) : undefined;
	var box = (below[0] || above[0] || drag.rows[0]).getBoundingClientRect();
	var edge = below.length || !above.length ? box.top : box.bottom;
	return { below: below, parent: parent, top: edge };
}

function dragMove(event) {
	if (!drag) return;
	if (!drag.moved && Math.abs(event.clientY - drag.y) < 5 && Math.abs(event.clientX - drag.x) < 5) return;
	drag.moved = true;
	event.preventDefault();
	drag.rows.addClass('dragging');
	if (event.clientY < 60) window.scrollBy(0, -12);
	if (event.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
	drag.place = dropPlace(event.clientY, event.clientX - drag.x);
	var list = $('#claire')[0].getBoundingClientRect();
	var left = list.left + parseFloat($('#claire').css('padding-left')) + (drag.place.parent ? 44 : 0);
	$('#drop-line').css({ top: drag.place.top - 1, left: left, width: list.right - left }).show();
}

function dragEnd(event) {
	if (!drag) return;
	var d = drag;
	drag = null;
	$('#drop-line').hide();
	d.rows.removeClass('dragging');
	if (event && event.type === 'pointerup' && d.place && $.contains(document, d.todo[0])) place(d.todo, d.place.below, d.place.parent);
}

document.addEventListener('pointerdown', function(event) {
	var handle = $(event.target).closest('#claire .handle');
	if (!handle.length || event.button || drag) return;
	event.preventDefault(); // no text selection
	var row = handle.parent(), todo = row.children('.todo');
	drag = { todo: todo, rows: row.add(subtaskRows(todo)), x: event.clientX, y: event.clientY, level: row.hasClass('subtask') ? 1 : 0 };
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

	$('ul.list')
		.on('keydown', '.todo', keydown)
		.on('focusin', 'li', function() {
			$('li.selected').removeClass('selected');
			selected = $(this).addClass('selected').children('.todo');
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
		.on('input change', '.todo, .notes, .due', function() {
			var row = $(this).closest('li');
			renderMeta(row);
			saveSoon(row.children('.todo'));
		})
		.on('change', 'input[type=checkbox]', function() { setCompleted($(this)); })
		.on('click', '.more', function() {
			var row = $(this).parent(), open = row.hasClass('menu-open');
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

	$('ul.list').on('click', '[data-move]', function() {
		var row = $(this).closest('li'), todo = row.children('.todo'), how = $(this).attr('data-move');
		closeMenu();
		if (how === 'details') toggleDetails(row);
		else if (how === 'delete') deleteAndMoveOn(todo);
		else moveRow(todo, how);
	});
	$(document).on('click', function(event) {
		if (!$(event.target).closest('.menu, .more').length) closeMenu();
	});
	$('#authorize-button').click(handleAuthClick);
	$('#lists').on('click', '[data-list]', function() { switchList($(this).attr('data-list')); });
	$('#side-toggle').click(function() { $('body').toggleClass('side-open'); });
	$('#new-list').click(function() { $('#new-list-form').show().children('input').val('').focus(); });
	$('#new-list-form').on('submit', function(event) {
		event.preventDefault();
		var title = $.trim($(this).hide().children('input').val());
		if (title) createList(title);
	}).on('keydown', function(event) {
		if (event.which === 27) $(this).hide();
	});
	$('#list-title').on('change', function() { renameList($.trim(this.value)); })
		.on('keydown', function(event) {
			if (event.which === 13) this.blur();
			if (event.which === 27) { $(this).val((currentList() || {}).title || ''); this.blur(); }
		});
	$('#log-out-button').click(logOut);
	$('#done-toggle').click(toggleDone);
	$('#done-more').click(loadDone);
	$(window).on('resize', autosizeAll);

	updateToDoCount();
	checkAuth();

});
