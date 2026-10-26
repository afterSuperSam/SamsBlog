import { siteConfig } from '../config/site';

// 连续可见十秒才发送一次；隐藏和离开立即撤销计时，不追踪鼠标或设备指纹。
export function initializePageView() {
  if (document.body.classList.contains('admin-page') || navigator.webdriver
    || !/^\/(?:about\/?|content\/?|articles\/[1-9]\d*\/?)?$/.test(location.pathname)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sent = false;
  const schedule = () => {
    clearTimeout(timer);
    if (sent || document.visibilityState !== 'visible') return;
    timer = setTimeout(() => {
      if (document.visibilityState !== 'visible' || sent) return;
      sent = true;
      document.removeEventListener('visibilitychange', schedule);
      void fetch('/api/page-view.json', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: location.pathname }), keepalive: true,
      }).then(async (response) => {
        if (!response.ok) throw new Error('Page view confirmation failed');
        const result = await response.json() as { totals?: { visitors: number; pageViews: number } };
        if (result.totals) document.dispatchEvent(new CustomEvent('site-statistics-updated', { detail: result.totals }));
      }).catch(() => { console.warn('Page view confirmation unavailable'); });
    }, siteConfig.analytics.visibleMilliseconds);
  };
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('pagehide', () => clearTimeout(timer));
  window.addEventListener('pageshow', schedule);
  schedule();
}
