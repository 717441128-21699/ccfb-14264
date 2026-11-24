import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    // 基准/headless 环境下避免监视浏览器 profile 等工作区外或锁定文件
    watch: process.env.VITE_NO_WATCH
      ? { ignored: ['**/.chrome-profile/**', '**/node_modules/**'] }
      : undefined,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
