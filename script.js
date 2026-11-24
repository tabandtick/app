var lastToDoList = $("ul.list");
var lastToDo = $(".todo");
lastToDo.focus();

$.fn.getCursorPosition = function() {
        var input = this.get(0);
        if (!input) return; // No (input) element found
        if ('selectionStart' in input) {
            // Standard-compliant browsers
            return input.selectionStart;
        } else if (document.selection) {
            // IE
            input.focus();
            var sel = document.selection.createRange();
            var selLen = document.selection.createRange().text.length;
            sel.moveStart('character', -input.value.length);
            return sel.text.length - selLen;
        }
    };

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

function toDoListLength() {
	return $("li").length;
}

function toDoLength() {
	return $('.todo').val().length;
}

function updateToDoCount() {
	var myToDoListCount = 0;
		$(".todo").each(function (index, el) {
			if ($(el).val().length > 0) {
				myToDoListCount = myToDoListCount + 1;
			}
		})
		$("#total").text(myToDoListCount);
}

function updateCheckboxStatus() {
	$('ul').on('change', 'input[type=checkbox]', function(event) {
		setCompleted($(event.target));
	});
}

var selected = $();

$("#delete-task-button").click(function (event) {
  if (!selected.length || !$.contains(document, selected[0])) {
    showMessage('Click a task first, then Delete Task.', null, null, 4000);
    return;
  }
  removeRow(selected, 'Task deleted.');
  selected = $();
});

$("#new-task-button").click(function (event) {
  newTask();
});

function toggleToDoCheckboxes() {
	$(".todo").each(function (index, el) {
	    if ($(el).val().length > 0) {
				$(this).parent().addClass('unhide');
		}
	    else {
				$(this).parent().removeClass('unhide');
		}
	});
}

function keydown(event) {

	var li = $("<li></li>");
	var input = $('<input type="text" class="todo"/><input type="checkbox"/>');
	var eventCode = event.which || event.keyCode;

	var currentToDo = $(event.currentTarget);
	var currentToDoText = currentToDo.val();
	var currentToDoListItem = currentToDo.parent();

	var currentToDoListPosition = ($("li").index(currentToDo.parent()) + 1);
	var currentToDoCursorPosition = currentToDo.getCursorPosition();
	var currentToDoTextEnd = currentToDoText.length;

	var nextToDo = currentToDo.parent().next().children().first();
	var nextToDoText = nextToDo.val();
	var nextToDoListItem = nextToDo.parent();

	var previousToDo = currentToDo.parent().prev().children().first();
	var previousToDoText = previousToDo.val();

	switch (eventCode) {

		case 13: //enter
			event.preventDefault();
			currentToDoListItem.after(li.append(input));
			var nextToDo = currentToDo.parent().next().children().first(); //Why does this variable need to be repeated?
			var currentToDoTextRemaining = currentToDoText.substring(0, currentToDoCursorPosition);
			var currentToDoTextMoving = currentToDoText.substring(currentToDoCursorPosition, currentToDoTextEnd);
			currentToDo.val(currentToDoTextRemaining);
			nextToDo.val(currentToDoTextMoving);
			nextToDo.setCursorPosition(0);
			saveSoon(currentToDo);
			saveSoon(nextToDo);
		break;

		case 8: //backspace
			// Not while text is selected: that backspace should just clear it.
			if (toDoListLength() > 1 && currentToDoCursorPosition == 0 && currentToDo[0].selectionEnd == 0) {
				if (currentToDoListPosition > 1) {
					event.preventDefault();
					mergeRows(currentToDo.parent().prev().children().first(), currentToDo);
				}
				else if (!currentToDoText) {
					event.preventDefault();
					removeRow(currentToDo, 'Task deleted.');
					nextToDo.setCursorPosition(0);
				}
			}
		break;

		case 46: //delete
			if (currentToDoListPosition !== toDoListLength() && currentToDoCursorPosition == currentToDoTextEnd) {
				event.preventDefault();
				mergeRows(currentToDo, nextToDo);
			}
		break;

		case 40: //down arrow
			if (toDoListLength() > 1) {
				event.preventDefault();
				nextToDo.setCursorPosition(currentToDoCursorPosition);

			}
		break;

		case 38: //up arrow
			if (toDoListLength() > 1) {
				event.preventDefault();
				previousToDo.setCursorPosition(currentToDoCursorPosition);
			}
		break;
	}
	updateToDoCount();
	toggleToDoCheckboxes();
}

$(document).ready(function() {

	lastToDoList.on('keydown', ".todo", keydown);
	lastToDoList.on('focusin', ".todo", function() {
		$('li.selected').removeClass('selected');
		selected = $(this);
		selected.parent().addClass('selected');
	});
	lastToDoList.on('focusout', ".todo", function() { saveTitle($(this)); });
	lastToDoList.on('input', ".todo", function() { saveSoon($(this)); });
	lastToDoList.on('input', ".todo", updateToDoCount);
	lastToDoList.on('input', ".todo", toggleToDoCheckboxes);

	updateToDoCount();

	updateCheckboxStatus();

});
