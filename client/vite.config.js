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
      '/relationship-types': 'http://localhost:3004',
      '/relationship-groups': 'http://localhost:3004',
      '/events': 'http://localhost:3004',
      '/changelog': 'http://localhost:3004',
      '/mcp': 'http://localhost:3004',
    },
  },
});
