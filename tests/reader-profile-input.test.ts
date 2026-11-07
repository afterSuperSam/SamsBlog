import { describe, expect, it, vi } from 'vitest';
import { applySubmittedReaderInput } from '../src/lib/reader-account-client';

vi.mock('../src/lib/reader-effects', () => ({ setReaderFeedback: vi.fn() }));
vi.mock('../src/lib/reader-menu', () => ({ renderReaderMethodBadge: vi.fn() }));

function input(value: string, selectionStart = 1, selectionEnd = 3) {
  return { value, selectionStart, selectionEnd, selectionDirection: 'forward' as const, setSelectionRange: vi.fn() };
}

describe('reader profile response reconciliation', () => {
  it('preserves edits made while the submitted request is pending', () => {
    const field = input('后来输入的新昵称');
    applySubmittedReaderInput(field, '原昵称', '原昵称');
    expect(field.value).toBe('后来输入的新昵称');
    expect(field.setSelectionRange).not.toHaveBeenCalled();
  });
  it('does not reset value or selection when the server returned unchanged text', () => {
    const field = input('同一个昵称');
    applySubmittedReaderInput(field, '同一个昵称', '同一个昵称');
    expect(field.setSelectionRange).not.toHaveBeenCalled();
  });
  it('retains a bounded selection when normalizing unchanged submitted input', () => {
    const field = input('  昵称  ', 1, 6);
    applySubmittedReaderInput(field, '  昵称  ', '昵称');
    expect(field.value).toBe('昵称');
    expect(field.setSelectionRange).toHaveBeenCalledWith(1, 2, 'forward');
  });
});
