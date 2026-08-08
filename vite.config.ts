import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: [
        'apple-touch-icon.png',
        'pwa-icon.svg',
        'pwa-icon-192.png',
        'pwa-icon-512.png',
        'pwa-icon-maskable-512.png',
        'pwa-screenshot-mobile.png',
        'pwa-screenshot-wide.png',
      ],
      manifest: {
        id: '/',
        name: 'ระบบจัดส่งน้ำแข็งศูนย์ราชการ',
        short_name: 'ส่งน้ำแข็ง',
        description: 'จัดการการส่งน้ำแข็ง สต๊อก ร้านค้า และการรับชำระของศูนย์ราชการ',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone', 'minimal-ui'],
        background_color: '#f5fbfd',
        theme_color: '#063a70',
        lang: 'th',
        dir: 'ltr',
        categories: ['business', 'productivity'],
        icons: [
          { src: 'pwa-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        screenshots: [
          {
            src: 'pwa-screenshot-mobile.png',
            sizes: '426x848',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'หน้ารับและโอนน้ำแข็งสำหรับพนักงาน',
          },
          {
            src: 'pwa-screenshot-wide.png',
            sizes: '1440x1000',
            type: 'image/png',
            form_factor: 'wide',
            label: 'หน้าควบคุมสต๊อกน้ำแข็งสำหรับหัวหน้า',
          },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        navigationPreload: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-font-stylesheets',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-font-files',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
