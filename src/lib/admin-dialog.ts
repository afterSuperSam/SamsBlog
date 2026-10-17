// 后台确认统一使用主题对话框，取消、关闭与焦点恢复集中处理。
export async function confirmAdminAction(message: string, confirmLabel = '确定'): Promise<boolean> {
  const dialog = document.querySelector<HTMLDialogElement>('[data-admin-confirm]');
  const copy = dialog?.querySelector<HTMLElement>('[data-admin-confirm-message]');
  const confirm = dialog?.querySelector<HTMLButtonElement>('[data-admin-confirm-accept]');
  const cancel = dialog?.querySelector<HTMLButtonElement>('[data-admin-confirm-cancel]');
  if (!dialog || !copy || !confirm || !cancel) {
    console.error('Admin confirmation dialog unavailable');
    return false;
  }
  if (dialog.open) return false;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  copy.textContent = message;
  confirm.textContent = confirmLabel;
  dialog.returnValue = 'cancel';
  return new Promise<boolean>((resolve) => {
    const accept = () => dialog.close('confirm');
    const decline = () => dialog.close('cancel');
    const outside = (event: MouseEvent) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) decline();
    };
    const finish = () => {
      confirm.removeEventListener('click', accept);
      cancel.removeEventListener('click', decline);
      dialog.removeEventListener('click', outside);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(dialog.returnValue === 'confirm');
    };
    confirm.addEventListener('click', accept);
    cancel.addEventListener('click', decline);
    dialog.addEventListener('click', outside);
    dialog.addEventListener('close', finish, { once: true });
    dialog.showModal();
    cancel.focus();
  });
}
