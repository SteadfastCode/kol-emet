import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/entries': 'http://localhost:3001',
      '/tags': 'http://localhost:3001',
      '/open-questions': 'http://localhost:3001',
    },
  },
});
