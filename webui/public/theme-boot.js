// 首屏主题初始化（独立脚本，满足 CSP 的 script-src 'self'）
// 在 Vue 挂载前把 html[data-app-theme] 设好，避免深色模式下闪白。
(function () {
  try {
    var mode = localStorage.getItem('busychat_theme_mode') || 'system';
    var dark =
      mode === 'dark' ||
      (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-app-theme', dark ? 'dark' : 'light');
    document.documentElement.style.backgroundColor = dark ? '#1a1a1a' : '#f6f8fb';
  } catch (e) {
    // localStorage 不可用时交给 Vue 挂载后处理
  }
})();
