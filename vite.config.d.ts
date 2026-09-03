export declare const r2CatalogImagePattern: RegExp;
export declare const supabaseCatalogImagePattern: RegExp;
export declare const catalogImageRuntimeCaching: {
    urlPattern: RegExp;
    handler: "CacheFirst";
    options: {
        cacheName: string;
        cacheableResponse: {
            statuses: number[];
        };
        expiration: {
            maxEntries: number;
            maxAgeSeconds: number;
            purgeOnQuotaError: true;
        };
    };
}[];
declare const _default: import("vite").UserConfig;
export default _default;
