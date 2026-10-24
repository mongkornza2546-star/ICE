import { defineConfig, loadEnv, type Plugin } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import type { RuntimeCaching } from 'workbox-build';
import { employeeStyles } from './scripts/employee-styles.mjs';

export const r2CatalogImagePattern = /^https:\/\/[^/]+\.r2\.cloudflarestorage\.com\/(?:[^/]+\/)?(?:shop-images|ice-type-images)\//;
export const supabaseCatalogImagePattern = /^https:\/\/[^/]+\/storage\/v1\/object\/public\/(?:shop-images|ice-type-images)\//;
export const catalogImageRuntimeCaching = [
  {
    urlPattern: r2CatalogImagePattern,
    handler: 'StaleWhileRevalidate',
    options: {
      cacheName: 'catalog-r2-images-v3',
      cacheableResponse: { statuses: [200] },
      expiration: {
        maxEntries: 500,
        maxAgeSeconds: 60 * 60 * 24 * 30,
        purgeOnQuotaError: true,
      },
    },
  },
  {
    urlPattern: supabaseCatalogImagePattern,
    handler: 'CacheFirst',
    options: {
      cacheName: 'catalog-public-images-v2',
      cacheableResponse: { statuses: [200] },
      expiration: {
        maxEntries: 500,
        maxAgeSeconds: 60 * 60 * 24 * 365,
        purgeOnQuotaError: true,
      },
    },
  },
] satisfies RuntimeCaching[];

function employeeBuild(): Plugin {
  return {
    name: 'employee-apk',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace('/src/main.tsx', '/src/main.employee.tsx');
      },
    },
    generateBundle(_options, bundle) {
      const modules = Object.values(bundle).flatMap((output) => output.type === 'chunk'
        ? Object.entries(output.modules).filter(([, info]) => info.renderedLength > 0).map(([id]) => id.replaceAll('\\', '/'))
        : []);
      const forbidden = modules.filter((id) => /\/src\/(?:AdminRoleWorkspace|AdminLayout|AdminReferenceSettings|ManagerDashboard|FactoryOrderPage|LocationManagementSettings|ShopSettings|RoundWorkspace|ManagerStockAudit|EventManagementPage|LocalDemoApp)\.tsx$|\/src\/features\/(?:accounting|reports)\/|\/(?:FinancialManagerWorkspace|CollectionDesk|CreditReceivablesManager)\.tsx$/.test(id));
      if (forbidden.length) this.error(`Employee build contains admin code: ${forbidden.join(', ')}`);
      for (const name of readdirSync('public/fonts')) {
        this.emitFile({ type: 'asset', fileName: `fonts/${name}`, source: readFileSync(`public/fonts/${name}`) });
      }
      for (const name of ['pwa-icon.svg', 'apple-touch-icon.png']) {
        this.emitFile({ type: 'asset', fileName: name, source: readFileSync(`public/${name}`) });
      }
      this.emitFile({
        type: 'asset',
        fileName: 'employee-build.json',
        source: JSON.stringify({
          target: 'employee',
          modules: modules.filter((id) => id.includes('/src/')).map((id) => id.slice(id.lastIndexOf('/src/') + 1)).sort(),
        }, null, 2),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const employeeOnly = mode === 'employee';
  if (employeeOnly) {
    const env = loadEnv(mode, process.cwd());
    if (!env.VITE_SUPABASE_URL?.trim() || !env.VITE_SUPABASE_ANON_KEY?.trim()) {
      throw new Error('Employee APK requires the live Supabase URL and anon key.');
    }
  }
  return {
    define: {
      'import.meta.env.VITE_EMPLOYEE_ONLY': JSON.stringify(employeeOnly ? 'true' : 'false'),
      ...(employeeOnly ? { 'import.meta.env.VITE_APP_MODE': JSON.stringify('live') } : {}),
    },
    build: { outDir: employeeOnly ? 'dist-employee' : 'dist', copyPublicDir: !employeeOnly },
    css: employeeOnly ? { postcss: { plugins: [employeeStyles()] } } : undefined,
    plugins: [
      react(),
      employeeOnly ? employeeBuild() : VitePWA({
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
            ...catalogImageRuntimeCaching,
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
  };
});
