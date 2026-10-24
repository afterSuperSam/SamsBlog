import { confirmAdminDiscard } from './admin-dialog';
import { animateMotion } from './motion';

const duration = (name: string) => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));

// 抽屉统一管理进入、退出和焦点，表单本身继续由各业务组件维护。
export function openAdminDrawer(dialog: HTMLDialogElement) {
  if (dialog.open) return;
  const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusScope = dialog.closest<HTMLElement>('.admin-panel');
  dialog.showModal();
  document.documentElement.classList.add('admin-drawer-open');
  animateMotion(dialog, [{ opacity: 0, translate: '48px 0' }, { opacity: 1, translate: '0 0' }], { duration: duration('--motion-spring-duration'), easing: getComputedStyle(dialog).getPropertyValue('--ease-out').trim() });
  dialog.addEventListener('close', () => {
    if (!document.querySelector('[data-admin-drawer][open]')) document.documentElement.classList.remove('admin-drawer-open');
    const target = focus?.isConnected ? focus : [...focusScope?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []]
      .find((button) => !button.closest('dialog') && button.getClientRects().length > 0);
    target?.focus({ preventScroll: true });
  }, { once: true });
}

async function closeDrawer(dialog: HTMLDialogElement) {
  if (dialog.hasAttribute('data-closing') || dialog.closest('[aria-busy="true"]') || dialog.querySelector('[aria-busy="true"],[data-autosave-busy="true"]')) return;
  const owner = dialog.closest<HTMLElement>('[data-admin-articles],[data-admin-projects]') || dialog.querySelector<HTMLElement>('[data-draft-owner]');
  if (owner && !await confirmAdminDiscard(owner)) return;
  dialog.dataset.closing = '';
  const animation = animateMotion(dialog, [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '32px 0' }], { duration: duration('--motion-feedback-duration'), easing: getComputedStyle(dialog).getPropertyValue('--ease-out').trim() });
  if (animation) await animation.finished.catch(() => undefined);
  dialog.close();
  delete dialog.dataset.closing;
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const opener = target?.closest<HTMLElement>('[data-drawer-open]');
  if (opener) {
    const dialog = document.getElementById(opener.dataset.drawerOpen || '');
    if (dialog instanceof HTMLDialogElement) openAdminDrawer(dialog);
  }
  const closer = target?.closest('[data-drawer-close]');
  const dialog = closer?.closest<HTMLDialogElement>('[data-admin-drawer]');
  if (dialog) void closeDrawer(dialog);
  if (target instanceof HTMLDialogElement && target.hasAttribute('data-admin-drawer')) {
    const bounds = target.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) void closeDrawer(target);
  }
});
document.addEventListener('cancel', (event) => {
  if (event.target instanceof HTMLDialogElement && event.target.hasAttribute('data-admin-drawer')) { event.preventDefault(); void closeDrawer(event.target); }
}, true);
