import { siteConfig } from '../config/site';
import { requestJson } from './client-request';

interface FlowConfirmation { error?: string; status: string }
type OAuthAction = Record<string, unknown> | (() => Promise<Record<string, unknown>>);

export function acceptsOAuthCompletion(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, popup: Window, origin: string, flowId?: string) {
  return event.origin === origin && event.source === popup && event.data?.type === 'samsblog-reader-oauth'
    && ['success', 'error'].includes(event.data?.status) && Boolean(flowId && event.data?.flowId === flowId);
}

// 窗口消息只是提示；只有本次流程和服务端会话共同匹配才完成。
export function openReaderOAuthPopup(startUrl: string, signal: AbortSignal, action: OAuthAction = {}): Promise<void> {
  const configuration = siteConfig.readerPopup;
  const width = Math.min(configuration.widthPixels, screen.availWidth);
  const height = Math.min(configuration.heightPixels, screen.availHeight);
  const popup = window.open('about:blank', '_blank', `popup=yes,width=${width},height=${height},left=${Math.max(0, window.screenX + (window.outerWidth - width) / 2)},top=${Math.max(0, window.screenY + (window.outerHeight - height) / 2)}`);
  if (!popup) return Promise.reject(new Error('浏览器阻止了登录窗口，请允许本站弹出窗口后重试。'));
  const flowId = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let started = false;
    let starting = false;
    let pendingFailure: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      if (error && starting) {
        pendingFailure = error;
        try { popup.close(); } catch { /* 浏览器隔离不影响服务端取消。 */ }
        return;
      }
      settled = true; clearTimeout(timer); clearTimeout(deadline);
      window.removeEventListener('message', message); window.removeEventListener('focus', focus);
      signal.removeEventListener('abort', cancel);
      try { popup.close(); } catch { /* 跨源窗口可能已与主窗口隔离。 */ }
      if (!error) { resolve(); return; }
      void requestJson<FlowConfirmation>('/api/reader/oauth/flow.json', 'DELETE', { flowId }, '取消结果尚未确认。').then((result) => {
        // 回调若先提交成功，取消不得把已完成流程误报成失败。
        if (result.status === 'completed') resolve(); else reject(error);
      }, () => reject(new Error(`${error.message} 结束请求未能确认，请稍后刷新账号页。`)));
    };
    const check = async () => {
      if (settled || checking || !started) return;
      checking = true;
      try {
        const current = await requestJson<FlowConfirmation>(`/api/reader/oauth/flow.json?flow=${encodeURIComponent(flowId)}`, 'GET', undefined, '暂时无法确认授权状态。');
        if (!settled) {
          if (current.status === 'completed') finish();
          else if (['failed', 'cancelled', 'expired'].includes(current.status)) finish(new Error('这次授权已结束，请重试。'));
          else if (popup.closed) finish(new Error('授权窗口已关闭，可以重新选择登录方式。'));
        }
      } catch { /* 短暂网络错误保留流程，截止时尝试服务端取消。 */ }
      finally {
        checking = false;
        if (!settled) { clearTimeout(timer); timer = setTimeout(() => void check(), configuration.pollMilliseconds); }
      }
    };
    const message = (event: MessageEvent) => {
      if (!acceptsOAuthCompletion(event, popup, window.location.origin, flowId)) return;
      void check();
    };
    const focus = () => { void check(); };
    const cancel = () => finish(new Error('已取消授权，可以重新选择登录方式。'));
    const deadline = setTimeout(() => finish(new Error('尚未确认授权完成，请重试。')), configuration.timeoutMilliseconds);
    window.addEventListener('message', message); window.addEventListener('focus', focus); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    void (async () => {
      starting = true;
      try {
        const payload = typeof action === 'function' ? await action() : action;
        if (pendingFailure) { starting = false; finish(pendingFailure); return; }
        const result = await requestJson<{ error?: string; url: string; flowId: string }>(startUrl, 'POST', { ...payload, flowId }, '暂时无法开始授权。');
        starting = false;
        if (pendingFailure) { finish(pendingFailure); return; }
        if (settled) return;
        if (result.flowId !== flowId) throw new Error('授权流程不匹配，请重试。');
        const address = new URL(result.url);
        if (!['http:', 'https:'].includes(address.protocol)) throw new Error('登录地址不可用。');
        popup.location.href = address.href; started = true;
        timer = setTimeout(() => void check(), configuration.pollMilliseconds);
      } catch (error) {
        starting = false;
        finish(pendingFailure || (error instanceof Error ? error : new Error('暂时无法开始授权。')));
      }
    })();
  });
}
