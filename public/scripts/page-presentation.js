(() => {
  // 旧文章列表锚点保留筛选参数并转入内容页。
  if (/^\/about\/?$/.test(location.pathname) && location.hash === '#articles') {
    location.replace(`/content${location.search}`);
    return;
  }
  // 首帧偏好与页面转场使用同源脚本，避免生产 CSP 对内联脚本哈希的依赖。
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const syncPreferences = () => {
    let theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    let paused = root.classList.contains('motion-paused');
    try {
      const savedTheme = localStorage.getItem('samsblog-theme');
      if (savedTheme === 'dark' || savedTheme === 'light') theme = savedTheme;
      paused = localStorage.getItem('samsblog-motion') === 'paused';
      if (root.dataset.readingFontStorageKey) root.dataset.articleFont = localStorage.getItem(root.dataset.readingFontStorageKey) === 'default' ? 'default' : 'handwritten';
      if (root.dataset.readingTypography) {
        const configuration = JSON.parse(root.dataset.readingTypography);
        const value = JSON.parse(localStorage.getItem(configuration.storageKey) || 'null');
        if (value && Number.isSafeInteger(value.fontSize) && value.fontSize >= configuration.minimum && value.fontSize <= configuration.maximum && (value.fontSize - configuration.minimum) % configuration.step === 0) root.style.setProperty('--reader-font-size', `${value.fontSize / 16}rem`);
        else root.style.removeProperty('--reader-font-size');
        root.dataset.readingSpacing = value?.spacing === 'relaxed' ? 'relaxed' : 'standard';
      }
    } catch (error) { console.warn('Theme preference unavailable', error); }
    root.dataset.theme = theme;
    root.classList.toggle('motion-paused', paused || reducedMotion.matches);
    document.querySelector('meta[data-theme-color]')?.setAttribute('content', theme === 'dark' ? '#202123' : '#f4fbfc');
  };
  syncPreferences();

  const syncTransition = (event) => {
    delete root.dataset.pageTransition;
    if (!event.viewTransition) return;
    if (reducedMotion.matches || root.classList.contains('motion-paused')) { event.viewTransition.skipTransition(); return; }
    // 页面跳转共用整页快照，避免图片或导航单独衔接。
    root.dataset.pageTransition = 'soft';
    const cleanup = () => { delete root.dataset.pageTransition; };
    void event.viewTransition.finished.then(cleanup, cleanup);
  };
  window.addEventListener('pagereveal', (event) => {
    syncPreferences();
    syncTransition(event);
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) syncPreferences(); });
  window.addEventListener('pageswap', syncTransition);
})();
