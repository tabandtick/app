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
	$('#total').text(count);
	$('#empty').toggle(tasksLoaded && !$('#claire li').length);
}

// A row only gets a tick box once it has a title.
function toggleToDoCheckboxes() {
	$('.todo').each(function() {
		$(this).parent().toggleClass('unhide', this.value.length > 0);
	});
}

var selected = $();

$('#new-task-button, #empty-new').click(function() { newTask(); });

$('#delete-task-button').click(function() {
	if (!selected.length || !$.contains(document, selected[0])) {
		showMessage('Click a task first, then Delete Task.', null, null, 4000);
		return;
	}
	var rows = selected.parent().add(subtaskRows(selected));
	var row = rows.last().next().length ? rows.last().next() : rows.first().prev();
	var following = row.children('.todo');
	removeRow(selected);
	selected = $();
	// Ready to delete the next one. Caret at the end, so Backspace edits its text.
	if (following.length) following.setCursorPosition(following.val().length);
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

	switch (event.which || event.keyCode) {

		case 13: //enter
			event.preventDefault();
			if (completed) todo.blur();
			else splitRow(todo);
		break;

		case 8: //backspace
			if (completed || position !== 0 || !caret) break;
			if (previous.length) {
				event.preventDefault();
				mergeRows(previous, todo);
			}
			else if (!length && next.length) {
				event.preventDefault();
				removeRow(todo);
				next.setCursorPosition(0);
			}
		break;

		case 46: //delete
			if (completed || position !== length || !caret || !next.length) break;
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

$(document).ready(function() {

	$('ul.list')
		.on('keydown', '.todo', keydown)
		.on('focusin', 'li', function() {
			$('li.selected').removeClass('selected');
			selected = $(this).addClass('selected').children('.todo');
		})
		.on('focusout', '.todo, .notes, .due', function() { saveTask($(this).closest('li').children('.todo')); })
		.on('input', '.todo', function() {
			if (/\n/.test(this.value)) this.value = this.value.replace(/\n+/g, ' '); // pasted lines
			autosize($(this));
			updateToDoCount();
			toggleToDoCheckboxes();
		})
		.on('input change', '.todo, .notes, .due', function() {
			var row = $(this).closest('li');
			renderMeta(row);
			saveSoon(row.children('.todo'));
		})
		.on('change', 'input[type=checkbox]', function() { setCompleted($(this)); })
		.on('click', '.more', function() {
			var row = $(this).parent().toggleClass('open');
			$(this).attr('aria-expanded', String(row.hasClass('open')));
			if (row.hasClass('open')) row.find('.notes').focus();
		})
		.on('click', '.clear-due', function() {
			var row = $(this).closest('li');
			row.find('.due').val('');
			renderMeta(row);
			saveTask(row.children('.todo'));
		});

	$('#done-toggle').click(toggleDone);
	$('#done-more').click(loadDone);
	$(window).on('resize', function() { $('.todo').each(function() { autosize($(this)); }); });

	updateToDoCount();

});
