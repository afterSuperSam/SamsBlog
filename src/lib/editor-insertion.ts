export interface EditorInsertion {
  value: string;
  start: number;
  end: number;
}

export interface EditorChange extends EditorInsertion { inputType: string; }

// 跟随上传期间的文本编辑；选区被改写时只插入，不覆盖新输入。
export function updateEditorInsertion(insertion: EditorInsertion, value: string, change?: EditorChange) {
  const previous = insertion.value;
  if (previous === value) return;
  let start = 0;
  let oldEnd = previous.length;
  let newEnd = value.length;
  let located = false;
  if (change?.value === previous) {
    start = change.start; oldEnd = change.end;
    const removed = previous.length - value.length;
    if (start === oldEnd && removed > 0) {
      if (change.inputType.endsWith('Backward')) start -= removed;
      else if (change.inputType.endsWith('Forward')) oldEnd += removed;
    }
    newEnd = oldEnd + value.length - previous.length;
    located = start >= 0 && oldEnd >= start && oldEnd <= previous.length && newEnd >= start
      && previous.slice(0, start) === value.slice(0, start) && previous.slice(oldEnd) === value.slice(newEnd);
  }
  if (!located) {
    start = 0; oldEnd = previous.length; newEnd = value.length;
    while (start < previous.length && start < value.length && previous[start] === value[start]) start++;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
  }
  const difference = newEnd - oldEnd;
  if (oldEnd <= insertion.start) { insertion.start += difference; insertion.end += difference; }
  else if (start < insertion.end || start === insertion.start) {
    insertion.start = Math.min(insertion.start, start);
    insertion.end = insertion.start;
  }
  insertion.value = value;
}
