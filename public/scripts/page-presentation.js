(() => {
  // 旧文章列表锚点保留筛选参数并转入内容页。
  if (/^\/about\/?$/.test(location.pathname) && location.hash === '#articles') {
    location.replace(`/content${location.search}`);
    return;
  }
  // 首帧主题与封面绑定使用同源脚本，避免生产 CSP 对内联脚本哈希的依赖。
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const pageRoutes = new Set(JSON.parse(root.dataset.pageRoutes || '[]'));
  const syncPreferences = () => {
    let theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    let paused = root.classList.contains('motion-paused');
    try {
      const savedTheme = localStorage.getItem('samsblog-theme');
      if (savedTheme === 'dark' || savedTheme === 'light') theme = savedTheme;
      paused = localStorage.getItem('samsblog-motion') === 'paused';
    } catch (error) { console.warn('Theme preference unavailable', error); }
    root.dataset.theme = theme;
    root.classList.toggle('motion-paused', paused || reducedMotion.matches);
    document.querySelector('meta[data-theme-color]')?.setAttribute('content', theme === 'dark' ? '#202123' : '#f4fbfc');
  };
  syncPreferences();

  const prepareCovers = (destination = location.href, separateCovers = true) => {
    root.dataset.coverDirection = /^\/articles\/\d+\/?$/.test(new URL(destination, location.href).pathname) ? 'enter' : 'return';
    document.querySelectorAll('[data-article-cover]').forEach((cover) => {
      const visible = separateCovers && !cover.closest('[hidden]');
      cover.style.setProperty('view-transition-name', visible ? `article-cover-${cover.dataset.articleCover}` : 'none');
    });
  };
  const syncTransition = (event, from, destination) => {
    const previous = from ? new URL(from, location.href) : null;
    const next = new URL(destination, location.href);
    const normalizePath = (pathname) => pathname.replace(/\/$/, '') || '/';
    const pageChange = previous?.origin === location.origin && next.origin === location.origin
      && pageRoutes.has(normalizePath(previous.pathname)) && pageRoutes.has(normalizePath(next.pathname))
      && normalizePath(previous.pathname) !== normalizePath(next.pathname);
    prepareCovers(destination, !pageChange);
    delete root.dataset.pageTransition;
    if (!event.viewTransition) return;
    if (reducedMotion.matches || root.classList.contains('motion-paused')) { event.viewTransition.skipTransition(); return; }
    // 主导航只切换正文快照，导航固定；文章继续连接封面。
    if (pageChange) root.dataset.pageTransition = 'soft';
    const cleanup = () => { delete root.dataset.pageTransition; prepareCovers(); };
    void event.viewTransition.finished.then(cleanup, cleanup);
  };
  document.addEventListener('DOMContentLoaded', () => prepareCovers(location.href, root.dataset.pageTransition !== 'soft'), { once: true });
  window.addEventListener('pagereveal', (event) => {
    syncPreferences();
    syncTransition(event, window.navigation?.activation?.from?.url, location.href);
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) syncPreferences(); });
  window.addEventListener('pageswap', (event) => syncTransition(event, location.href, event.activation?.entry?.url || location.href));
})();
