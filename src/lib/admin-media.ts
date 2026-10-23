import type { MediaRecord } from './media';
import { beginAdminAction, confirmAdminAction } from './admin-dialog';
import { requestJson } from './client-request';
import { animateContentHeight } from './motion';

// 上传、回收站与编辑器选择共用一份媒体列表，不刷新正在编辑的文章。
const root = document.querySelector<HTMLElement>('[data-admin-media]');
if (root) {
  let records = JSON.parse(root.dataset.records || '[]') as MediaRecord[];
  delete root.dataset.records;
  const maximumBytes = Number(root.dataset.maximumBytes);
  const grid = root.querySelector<HTMLElement>('[data-media-grid]')!;
  const template = root.querySelector<HTMLTemplateElement>('[data-media-template]')!;
  const search = root.querySelector<HTMLInputElement>('[data-media-search]')!;
  const empty = root.querySelector<HTMLElement>('[data-media-empty]')!;
  const feedback = root.querySelector<HTMLElement>('[data-media-feedback]')!;
  const fileInput = root.querySelector<HTMLInputElement>('[data-media-file]')!;
  const editor = document.querySelector<HTMLFormElement>('[data-article-editor]')!;
  const articleRoot = editor.closest<HTMLElement>('[data-admin-articles]')!;
  let selection = 'active';
  let uploadTarget = 'library';
  let uploadButton: HTMLButtonElement | undefined;
  const message = (target: HTMLElement, text: string, state = '') => animateContentHeight(target, () => { target.textContent = text; target.dataset.state = state; });
  const insert = (media: MediaRecord, target: string) => editor.dispatchEvent(new CustomEvent('media-select', { detail: { url: media.url, name: media.name, target } }));
  const render = () => {
    const shown = records.filter((media) => Boolean(media.deletedAt) === (selection === 'deleted') && media.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
    grid.replaceChildren(...shown.map((media) => {
      const card = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
      card.dataset.mediaId = String(media.id);
      const address = media.deletedAt ? `/api/admin/media.json?preview=${media.filename}` : media.url;
      const image = card.querySelector<HTMLImageElement>('img')!;
      image.src = address; image.alt = media.name;
      card.querySelector<HTMLAnchorElement>('a')!.href = address;
      card.querySelector('h3')!.textContent = media.name;
      card.querySelector('small')!.textContent = `${(media.size / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB · ${new Date(media.createdAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      card.querySelectorAll<HTMLButtonElement>('[data-media-action]').forEach((button) => { button.hidden = (button.dataset.mediaAction === 'restore') !== Boolean(media.deletedAt); });
      return card;
    }));
    empty.hidden = shown.length > 0;
    empty.textContent = search.value.trim() ? '没有找到匹配的图片。' : selection === 'deleted' ? '回收站是空的。' : '还没有图片，上传第一张吧。';
  };
  root.querySelectorAll<HTMLButtonElement>('[data-media-filter]').forEach((button) => button.addEventListener('click', () => {
    selection = button.dataset.mediaFilter!;
    root.querySelectorAll('[data-media-filter]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    render();
  }));
  search.addEventListener('input', render);
  document.querySelectorAll<HTMLButtonElement>('[data-upload-media]').forEach((button) => button.addEventListener('click', () => {
    uploadTarget = button.dataset.uploadMedia!;
    uploadButton = button;
    fileInput.click();
  }));
  const run = async (owner: HTMLElement, status: HTMLElement, action: () => Promise<void>) => {
    const release = beginAdminAction(owner);
    if (!release) return;
    const controls = [...owner.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button')].filter((control) => !control.disabled);
    owner.setAttribute('aria-busy', 'true');
    controls.forEach((control) => { control.disabled = true; });
    try { await action(); }
    catch (error) { message(status, error instanceof TypeError ? '网络连接失败，请稍后重试。' : error instanceof Error ? error.message : '媒体操作失败。', 'error'); }
    finally { owner.removeAttribute('aria-busy'); controls.forEach((control) => { control.disabled = false; }); release(); }
  };
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    const target = uploadTarget;
    const trigger = uploadButton;
    const status = target === 'library' ? feedback : editor.querySelector<HTMLElement>('[data-article-feedback]')!;
    if (file.size > maximumBytes || !file.size) { message(status, `请选择不超过 ${maximumBytes / 1024 / 1024} MB 的图片。`, 'error'); return; }
    let uploaded: MediaRecord | undefined;
    await run(target === 'library' ? root : articleRoot, status, async () => {
      message(status, '正在上传图片…', 'loading');
      const form = new FormData(); form.set('file', file);
      const result = await requestJson<{ error?: string; media: MediaRecord }>('/api/admin/media.json', 'POST', form, '图片上传失败，请稍后重试。');
      uploaded = result.media;
      records = [uploaded, ...records.filter((media) => media.id !== uploaded!.id)];
      render();
      message(status, target === 'library' ? '图片已上传。' : '图片已上传，保存文章后公开展示。', 'success');
    });
    if (uploaded && target !== 'library') insert(uploaded, target);
    else trigger?.focus();
  });
  grid.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-media-action]') : null;
    if (!button || root.getAttribute('aria-busy') === 'true') return;
    const media = records.find((item) => item.id === Number(button.closest<HTMLElement>('[data-media-id]')?.dataset.mediaId));
    if (!media) return;
    const action = button.dataset.mediaAction;
    if (action === 'body' || action === 'cover') { insert(media, action); return; }
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(new URL(media.url, location.origin).href);
        button.textContent = '复制成功'; button.dataset.copyState = 'success';
        message(feedback, '图片地址已复制。', 'success');
      }
      catch { message(feedback, '无法自动复制，请打开图片后复制地址。', 'error'); }
      return;
    }
    if (action === 'delete') {
      if ([editor.elements.namedItem('coverUrl'), editor.elements.namedItem('content')].some((field) => (field as HTMLInputElement).value.includes(media.url))) {
        message(feedback, '当前文章草稿正在使用这张图片，请先移除引用。', 'error'); return;
      }
      if (!await confirmAdminAction('移入回收站后，图片地址将停止公开访问。可以在回收站恢复。', '移入回收站')) return;
    }
    await run(root, feedback, async () => {
      await requestJson('/api/admin/media.json', action === 'restore' ? 'PATCH' : 'DELETE', { id: media.id, ...(action === 'restore' ? { restore: true } : {}) }, '媒体操作失败，请稍后重试。');
      media.deletedAt = action === 'restore' ? null : new Date().toISOString();
      render();
      message(feedback, action === 'restore' ? '图片已恢复。' : '图片已移入回收站。', 'success');
    });
    if (!button.isConnected) root.querySelector<HTMLButtonElement>(`[data-media-filter="${selection}"]`)?.focus();
  });
  render();
}
