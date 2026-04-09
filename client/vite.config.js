import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/entries': 'http://localhost:3004',
      '/tags': 'http://localhost:3004',
      '/open-questions': 'http://localhost:3004',
      '/auth': 'http://localhost:3004',
    },
  },
});
