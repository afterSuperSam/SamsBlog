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

const drafts = new Map<HTMLElement, { snapshot: () => string; saved: string }>();
const pendingActions = new Set<HTMLElement>();
let leaving = false;
let restoreNavigation: (() => void) | undefined;

// 当前页面的草稿和写入共用离开协调，防止其他分区刷新丢失输入。
export function registerAdminDraft(owner: HTMLElement, snapshot: () => string) {
  const draft = { snapshot, saved: snapshot() };
  drafts.set(owner, draft);
  return () => { draft.saved = snapshot(); };
}

export async function confirmAdminDiscard(owner: HTMLElement) {
  if (leaving || pendingActions.size) return false;
  const draft = drafts.get(owner);
  return !draft || draft.saved === draft.snapshot()
    || await confirmAdminAction('当前修改尚未保存，是否放弃这些修改？', '放弃修改');
}

export function beginAdminAction(owner: HTMLElement): (() => void) | undefined {
  if (leaving || [...pendingActions].some((pending) => pending.contains(owner) || owner.contains(pending))) return;
  pendingActions.add(owner);
  return () => { pendingActions.delete(owner); };
}

export async function prepareAdminNavigation(savedOwner?: HTMLElement): Promise<(() => void) | undefined> {
  if (leaving || pendingActions.size) return;
  leaving = true;
  const changed = [...drafts].some(([owner, draft]) => owner !== savedOwner && draft.saved !== draft.snapshot());
  if (changed && !await confirmAdminAction('当前修改尚未保存，是否放弃这些修改？', '放弃修改')) {
    leaving = false;
    return;
  }
  const controls = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('.admin-shell input,.admin-shell textarea,.admin-shell select,.admin-shell button')]
    .filter((control) => !control.closest('[data-admin-confirm]'));
  const disabledStates = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    leaving = false;
    restoreNavigation = undefined;
    controls.forEach((control, index) => { control.disabled = disabledStates[index]; });
  };
  restoreNavigation = release;
  return release;
}

export function bindAdminNavigation() {
  window.addEventListener('pageshow', (event) => { if (event.persisted) restoreNavigation?.(); });
  document.addEventListener('click', async (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!link || event.defaultPrevented || event.button !== 0 || link.target === '_blank' || link.hasAttribute('download') || link.hasAttribute('data-rss-subscribe') || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search && url.hash) return;
    event.preventDefault();
    const release = await prepareAdminNavigation();
    if (!release) return;
    try {
      window.location.assign(link.href);
    } catch (error) {
      release();
      console.error('Admin navigation failed', error);
    }
  });
}
