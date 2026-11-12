import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * WebUI 构建配置。
 *
 * - `base: './'` + hash 路由：产物可以挂在任意 `settings.uiPath` 下，
 *   不需要为每个部署路径重新构建。
 * - `outDir: ../webui-dist`：后端 Hapi 直接从仓库根目录的 `webui-dist/` 读静态文件，
 *   与编译产物 `dist/` 分开，避免 `npm run build` 反复清空。
 */
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../webui-dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/onebot': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
