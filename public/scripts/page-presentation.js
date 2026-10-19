(() => {
  // 首帧主题与封面绑定使用同源脚本，避免生产 CSP 对内联脚本哈希的依赖。
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  try {
    const savedTheme = localStorage.getItem('samsblog-theme');
    if (savedTheme === 'dark' || savedTheme === 'light') theme = savedTheme;
    root.classList.toggle('motion-paused', localStorage.getItem('samsblog-motion') === 'paused');
  } catch (error) { console.warn('Theme preference unavailable', error); }
  root.dataset.theme = theme;
  document.querySelector('meta[data-theme-color]')?.setAttribute('content', theme === 'dark' ? '#202123' : '#f4fbfc');

  const prepareCovers = (destination = location.href) => {
    root.dataset.coverDirection = /^\/articles\/\d+\/?$/.test(new URL(destination, location.href).pathname) ? 'enter' : 'return';
    document.querySelectorAll('[data-article-cover]').forEach((cover) => {
      const visible = !cover.closest('[hidden]');
      cover.style.setProperty('view-transition-name', visible ? `article-cover-${cover.dataset.articleCover}` : 'none');
    });
  };
  const syncTransition = (event, destination) => {
    prepareCovers(destination);
    if (reducedMotion.matches || root.classList.contains('motion-paused')) event.viewTransition?.skipTransition();
  };
  document.addEventListener('DOMContentLoaded', () => prepareCovers(), { once: true });
  window.addEventListener('pagereveal', (event) => syncTransition(event, location.href));
  window.addEventListener('pageswap', (event) => syncTransition(event, event.activation?.entry?.url || location.href));
})();
