import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: false,
  publicDir: '../../../public',
  define: { 'import.meta.env.VITE_SUPABASE_URL': '""', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '""' },
  plugins: [react(), VitePWA({ registerType: 'autoUpdate', injectRegister: 'auto', manifest: false,
    workbox: { navigateFallback: '/index.html', cleanupOutdatedCaches: true } })],
  build: { target: 'esnext', outDir: '/private/tmp/ice-offline-browser-build', emptyOutDir: true },
});
