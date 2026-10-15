var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
import { defineConfig, loadEnv } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export var r2CatalogImagePattern = /^https:\/\/[^/]+\.r2\.cloudflarestorage\.com\/(?:[^/]+\/)?(?:shop-images|ice-type-images)\//;
export var supabaseCatalogImagePattern = /^https:\/\/[^/]+\/storage\/v1\/object\/public\/(?:shop-images|ice-type-images)\//;
export var catalogImageRuntimeCaching = [
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
];
function employeeBuild() {
    return {
        name: 'employee-apk',
        transformIndexHtml: {
            order: 'pre',
            handler: function (html) {
                return html.replace('/src/main.tsx', '/src/main.employee.tsx');
            },
        },
        generateBundle: function (_options, bundle) {
            var modules = Object.values(bundle).flatMap(function (output) { return output.type === 'chunk'
                ? Object.entries(output.modules).filter(function (_a) {
                    var info = _a[1];
                    return info.renderedLength > 0;
                }).map(function (_a) {
                    var id = _a[0];
                    return id.replaceAll('\\', '/');
                })
                : []; });
            var forbidden = modules.filter(function (id) { return /\/src\/(?:AdminRoleWorkspace|AdminLayout|AdminReferenceSettings|ManagerDashboard|FactoryOrderPage|LocationManagementSettings|ShopSettings|RoundWorkspace|ManagerStockAudit|EventManagementPage|LocalDemoApp)\.tsx$|\/src\/features\/(?:accounting|reports)\/|\/(?:FinancialManagerWorkspace|CollectionDesk|CreditReceivablesManager)\.tsx$/.test(id); });
            if (forbidden.length)
                this.error("Employee build contains admin code: ".concat(forbidden.join(', ')));
            for (var _i = 0, _a = readdirSync('public/fonts'); _i < _a.length; _i++) {
                var name_1 = _a[_i];
                this.emitFile({ type: 'asset', fileName: "fonts/".concat(name_1), source: readFileSync("public/fonts/".concat(name_1)) });
            }
            for (var _b = 0, _c = ['pwa-icon.svg', 'apple-touch-icon.png']; _b < _c.length; _b++) {
                var name_2 = _c[_b];
                this.emitFile({ type: 'asset', fileName: name_2, source: readFileSync("public/".concat(name_2)) });
            }
            this.emitFile({
                type: 'asset',
                fileName: 'employee-build.json',
                source: JSON.stringify({
                    target: 'employee',
                    modules: modules.filter(function (id) { return id.includes('/src/'); }).map(function (id) { return id.slice(id.lastIndexOf('/src/') + 1); }).sort(),
                }, null, 2),
            });
        },
    };
}
export default defineConfig(function (_a) {
    var _b, _c;
    var mode = _a.mode;
    var employeeOnly = mode === 'employee';
    if (employeeOnly) {
        var env = loadEnv(mode, process.cwd());
        if (!((_b = env.VITE_SUPABASE_URL) === null || _b === void 0 ? void 0 : _b.trim()) || !((_c = env.VITE_SUPABASE_ANON_KEY) === null || _c === void 0 ? void 0 : _c.trim())) {
            throw new Error('Employee APK requires the live Supabase URL and anon key.');
        }
    }
    return {
        define: __assign({ 'import.meta.env.VITE_EMPLOYEE_ONLY': JSON.stringify(employeeOnly ? 'true' : 'false') }, (employeeOnly ? { 'import.meta.env.VITE_APP_MODE': JSON.stringify('live') } : {})),
        build: { outDir: employeeOnly ? 'dist-employee' : 'dist', copyPublicDir: !employeeOnly },
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
                    runtimeCaching: __spreadArray(__spreadArray([], catalogImageRuntimeCaching, true), [
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
                    ], false),
                },
            }),
        ],
        server: {
            host: '0.0.0.0',
            port: 5173,
        },
    };
});
