import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const API = 'http://localhost:3004';

/**
 * Proxy everything that is NOT a frontend path, rather than listing API
 * prefixes one by one.
 *
 * The allowlist version failed silently three times — a route missing from it
 * is served the SPA shell, so the request comes back 200 with HTML instead of
 * erroring, and the feature just quietly does not work. It cost a debugging
 * session each time (/entities after the rename from /entries, then /chat and
 * /conversations, then /drafts).
 *
 * Inverting it moves the maintenance burden to the side that changes rarely:
 * new API routes work automatically, and only a new *frontend* path needs to
 * be added here. Anything unmatched below goes to the API, where a wrong guess
 * is a loud 404 rather than a silent shell.
 */
const FRONTEND = [
  '$',                       // /
  'index\\.html',
  'src/',                    // source modules in dev
  '@',                       // /@vite, /@id, /@fs, /@react-refresh …
  'node_modules/',
  'favicon',
  '.*\\.(svg|png|jpe?g|gif|webp|ico|woff2?|ttf|css|map)$',
];

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      [`^/(?!${FRONTEND.join('|')})`]: {
        target: API,
        changeOrigin: true,
        // Generation and chat stream over SSE; buffering would hold every
        // progress event until the run finished.
        ws: true,
      },
    },
  },
  // Read by Vitest, ignored by `vite build`. Component tests need a DOM.
  test: {
    environment: 'jsdom',
  },
});
