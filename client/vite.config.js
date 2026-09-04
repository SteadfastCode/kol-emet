import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    // Every API prefix the client calls must be listed here — anything missing
    // is silently served the SPA shell instead of being proxied, so requests
    // come back as 200 HTML rather than a visible failure.
    proxy: {
      '/entities': 'http://localhost:3004',
      '/tags': 'http://localhost:3004',
      '/open-questions': 'http://localhost:3004',
      '/auth': 'http://localhost:3004',
      '/relationship-types': 'http://localhost:3004',
      '/relationship-groups': 'http://localhost:3004',
      '/events': 'http://localhost:3004',
      '/chat': 'http://localhost:3004',
      '/conversations': 'http://localhost:3004',
      '/mcp': 'http://localhost:3004',
    },
  },
});
