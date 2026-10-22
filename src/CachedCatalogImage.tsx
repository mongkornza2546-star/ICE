import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { catalogImageCacheKey, discardCatalogImage, loadCatalogImage, readCatalogImageByPath, type CatalogImageNamespace } from './lib/catalogImageCache';

interface Props extends ImgHTMLAttributes<HTMLImageElement> {
  namespace?: CatalogImageNamespace;
  imagePath?: string | null;
  fallback?: ReactNode;
}

// Ordinary img events still drive the existing signed-URL retry controls.
export function CachedCatalogImage({ src, namespace, imagePath, fallback = null, loading = 'lazy', decoding = 'async', onError, ...props }: Props) {
  const imageRef = useRef<HTMLImageElement>(null);
  const identity = JSON.stringify([src, namespace, imagePath]);
  const [resolved, setResolved] = useState<{ identity: string; url: string | null } | null>(null);
  const canCache = Boolean((src && catalogImageCacheKey(src) || namespace && imagePath)
    && typeof globalThis.caches !== 'undefined' && typeof URL.createObjectURL === 'function');

  useEffect(() => {
    if (!canCache) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const load = async () => {
      try {
        const blob = src ? await loadCatalogImage(src, { signal: controller.signal })
          : namespace && imagePath ? await readCatalogImageByPath(namespace, imagePath) : null;
        if (controller.signal.aborted) return;
        objectUrl = blob ? URL.createObjectURL(blob) : undefined;
        setResolved({ identity, url: objectUrl ?? null });
      } catch {
        // Unsupported CORS/storage retains native img fallback and URL retries.
        if (!controller.signal.aborted) setResolved({ identity, url: src ?? null });
      }
    };
    let observer: IntersectionObserver | undefined;
    if (loading === 'lazy' && typeof IntersectionObserver !== 'undefined' && imageRef.current) {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        void load();
      }, { rootMargin: '200px' });
      observer.observe(imageRef.current);
    } else {
      void load();
    }
    return () => {
      controller.abort();
      observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, namespace, imagePath, identity, canCache, loading]);

  const result = resolved?.identity === identity ? resolved : null;
  const displayUrl = canCache ? result?.url : src;
  if ((!canCache && !src) || (result && result.url === null)) return <>{fallback}</>;
  return <img
    {...props}
    ref={imageRef}
    loading={loading}
    decoding={decoding}
    src={displayUrl ?? undefined}
    onError={(event) => {
      if (displayUrl?.startsWith('blob:')) {
        if (src) void discardCatalogImage(src);
        else if (namespace && imagePath) void discardCatalogImage('', { namespace, path: imagePath });
        setResolved({ identity, url: src ?? null });
        if (!src) onError?.(event);
      } else {
        onError?.(event);
      }
    }}
  />;
}
