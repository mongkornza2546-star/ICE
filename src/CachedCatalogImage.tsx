import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { catalogImageCacheKey, discardCatalogImage, loadCatalogImage, readCatalogImageByPath, type CatalogImageNamespace } from './lib/catalogImageCache';

interface Props extends ImgHTMLAttributes<HTMLImageElement> {
  namespace?: CatalogImageNamespace;
  imagePath?: string | null;
  fallback?: ReactNode;
  onCacheMiss?: () => void;
}

// Ordinary img events still drive the existing signed-URL retry controls.
export function CachedCatalogImage({ src, namespace, imagePath, fallback = null, onCacheMiss, loading = 'lazy', decoding = 'async', onError, ...props }: Props) {
  const imageRef = useRef<HTMLImageElement>(null);
  const cacheMissRef = useRef(onCacheMiss);
  cacheMissRef.current = onCacheMiss;
  const sourceRef = useRef(src);
  sourceRef.current = src;
  // Credentials may rotate while the displayed bytes still represent the
  // same object. Keep those bytes; fallbacks and later loads use the latest URL.
  const identity = JSON.stringify([src ? catalogImageCacheKey(src) ?? src : src, namespace, imagePath]);
  const [resolved, setResolved] = useState<{ identity: string; url: string | null } | null>(null);
  const canCache = Boolean((src && catalogImageCacheKey(src) || namespace && imagePath)
    && typeof globalThis.caches !== 'undefined' && typeof URL.createObjectURL === 'function');

  useEffect(() => {
    const source = sourceRef.current;
    if (!canCache) {
      if (!source && namespace && imagePath) {
        const retry = setTimeout(() => cacheMissRef.current?.(), 0);
        return () => clearTimeout(retry);
      }
      return;
    }
    let controller: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let objectUrl: string | undefined;
    let observer: IntersectionObserver | undefined;
    const fallbackToSource = () => {
      settled = true;
      observer?.disconnect();
      setResolved({ identity, url: sourceRef.current ?? null });
      if (!sourceRef.current) cacheMissRef.current?.();
    };
    const load = async () => {
      if (settled || controller) return;
      const request = new AbortController();
      controller = request;
      const currentSource = sourceRef.current;
      // Covers queue, storage and native-bridge stalls, not just HTTP timeouts.
      timeout = setTimeout(() => {
        if (!sourceRef.current) {
          // A restored path can be sharing a download that outlives navigation.
          // Show a placeholder, but keep listening for those bytes; requesting
          // another URL here can fail and hide a later successful download.
          settled = true;
          observer?.disconnect();
          setResolved({ identity, url: null });
          return;
        }
        request.abort();
        fallbackToSource();
      }, 8000);
      try {
        const blob = currentSource ? await loadCatalogImage(currentSource, { signal: request.signal })
          : namespace && imagePath ? await readCatalogImageByPath(namespace, imagePath, { signal: request.signal }) : null;
        if (request.signal.aborted) return;
        settled = true;
        observer?.disconnect();
        objectUrl = blob ? URL.createObjectURL(blob) : undefined;
        setResolved({ identity, url: objectUrl ?? null });
        if (!blob && !sourceRef.current) cacheMissRef.current?.();
      } catch {
        // Unsupported CORS/storage retains native img fallback and URL retries.
        if (!request.signal.aborted) fallbackToSource();
      } finally {
        if (controller === request) clearTimeout(timeout);
      }
    };
    if (loading === 'lazy' && typeof IntersectionObserver !== 'undefined' && imageRef.current) {
      observer = new IntersectionObserver((entries) => {
        if (settled) return;
        if (entries.some((entry) => entry.isIntersecting)) {
          void load();
        } else {
          // Scrolling does not unmount shop tiles. Release queued work here;
          // started downloads still finish and cache bytes for a later return.
          controller?.abort();
          controller = undefined;
          clearTimeout(timeout);
        }
      }, { rootMargin: '200px' });
      observer.observe(imageRef.current);
    } else {
      void load();
    }
    return () => {
      controller?.abort();
      clearTimeout(timeout);
      observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [namespace, imagePath, identity, canCache, loading]);

  const result = resolved?.identity === identity ? resolved : null;
  const displayUrl = canCache
    ? result?.url?.startsWith('blob:') ? result.url : result?.url ? src : result?.url
    : src;
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
