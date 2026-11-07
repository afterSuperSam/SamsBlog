import { siteConfig } from '../config/site';
import { requestJson } from './client-request';

interface SessionConfirmation { error?: string; reader: unknown; authenticatedAt: number | null }

export function acceptsOAuthCompletion(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, popup: Window, origin: string) {
  return event.origin === origin && event.source === popup && event.data?.type === 'samsblog-reader-oauth'
    && ['success', 'error'].includes(event.data?.status);
}

// 窗口必须在用户手势中打开；消息只提示复核，不跨窗口传递身份或令牌。
export function openReaderOAuthPopup(startUrl: string, signal: AbortSignal): Promise<void> {
  const configuration = siteConfig.readerPopup;
  const width = Math.min(configuration.widthPixels, screen.availWidth);
  const height = Math.min(configuration.heightPixels, screen.availHeight);
  const popup = window.open('about:blank', '_blank', `popup=yes,width=${width},height=${height},left=${Math.max(0, window.screenX + (window.outerWidth - width) / 2)},top=${Math.max(0, window.screenY + (window.outerHeight - height) / 2)}`);
  if (!popup) return Promise.reject(new Error('浏览器阻止了登录窗口，请允许本站弹出窗口后重试。'));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let started = false;
    let starting = false;
    let pendingFailure: Error | undefined;
    let baseline: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      if (error && starting) {
        pendingFailure = error;
        try { popup.close(); } catch { /* 隔离窗口无需继续操作。 */ }
        return;
      }
      settled = true; clearTimeout(timer); clearTimeout(deadline);
      window.removeEventListener('message', message); window.removeEventListener('focus', focus);
      signal.removeEventListener('abort', cancel);
      try { popup.close(); } catch { /* 跨源窗口可能已与主窗口隔离。 */ }
      if (error) reject(error); else resolve();
    };
    const check = async () => {
      if (settled || checking || !started) return;
      checking = true;
      try {
        const current = await requestJson<SessionConfirmation>('/api/reader/session.json', 'GET', undefined, '暂时无法确认登录状态。');
        if (!settled && current.reader && typeof current.authenticatedAt === 'number' && current.authenticatedAt !== baseline) finish();
      } catch { /* 短暂网络错误保留当前授权窗口，截止时统一提示重试。 */ }
      finally {
        checking = false;
        if (!settled) { clearTimeout(timer); timer = setTimeout(() => void check(), configuration.pollMilliseconds); }
      }
    };
    const message = (event: MessageEvent) => {
      if (!acceptsOAuthCompletion(event, popup, window.location.origin)) return;
      if (event.data.status === 'error') finish(new Error('这次授权未能完成，请重试。'));
      else void check();
    };
    const focus = () => { void check(); };
    const cancel = () => finish(new Error('已取消登录，可以重新选择登录方式。'));
    const deadline = setTimeout(() => finish(new Error('尚未确认登录完成。请检查授权窗口或重试。')), configuration.timeoutMilliseconds);
    window.addEventListener('message', message); window.addEventListener('focus', focus); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    void (async () => {
      try {
        const original = await requestJson<SessionConfirmation>('/api/reader/session.json', 'GET', undefined, '暂时无法确认登录状态。');
        if (settled) return;
        baseline = original.authenticatedAt;
        starting = true;
        let result: { error?: string; url: string };
        try { result = await requestJson<{ error?: string; url: string }>(startUrl, 'POST', {}, '暂时无法开始登录。'); }
        finally { starting = false; }
        if (pendingFailure) { finish(pendingFailure); return; }
        if (settled) return;
        const address = new URL(result.url);
        if (!['http:', 'https:'].includes(address.protocol)) throw new Error('登录地址不可用。');
        popup.location.href = address.href; started = true;
        timer = setTimeout(() => void check(), configuration.pollMilliseconds);
      } catch (error) { finish(pendingFailure || (error instanceof Error ? error : new Error('暂时无法开始登录。'))); }
    })();
  });
}
