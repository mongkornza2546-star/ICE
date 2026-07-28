import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'ระบบจัดส่งน้ำแข็งศูนย์ราชการ',
        short_name: 'ส่งน้ำแข็ง',
        start_url: '/',
        display: 'standalone',
        background_color: '#f5fbfd',
        theme_color: '#0b6f8e',
        icons: [
          { src: 'pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
