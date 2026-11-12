import { CachedCatalogImage } from '../../../CachedCatalogImage';
import React, { useEffect, useRef, useState } from 'react';
import { isR2Path, refreshR2CatalogObjectUrl } from '../../../lib/r2Storage';
import { withPublicShopImages } from '../utils';
import type { PublicImagePathItem } from '../../../lib/publicImageUrls';

export interface AutoRefreshShopImageProps {
  imageUrl?: string | null;
  imagePath?: string | null;
  retryKey?: number;
  alt?: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'sync' | 'auto';
  fallback: React.ReactNode;
  renderImage?: (src: string, onError: () => void) => React.ReactNode;
  onImageError?: () => void;
  onImageLoaded?: () => void;
}

export function AutoRefreshShopImage({
  imageUrl,
  imagePath,
  retryKey = 0,
  alt = '',
  className,
  loading = 'lazy',
  decoding = 'async',
  fallback,
  renderImage,
  onImageError,
  onImageLoaded,
}: AutoRefreshShopImageProps) {
  const [currentUrl, setCurrentUrl] = useState<string | null>(imageUrl ?? null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const retryRequestId = useRef(0);
  const pendingRequest = useRef<number | null>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    retryRequestId.current += 1;
    pendingRequest.current = null;
    setCurrentUrl(imageUrl ?? null);
    setLoadAttempt(0);
    setFailed(false);
  }, [imageUrl, imagePath, retryEpoch]);

  useEffect(() => {
    if (!failed) return;
    const retry = () => setRetryEpoch((epoch) => epoch + 1);
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [failed]);

  const previousRetryKey = useRef(retryKey);
  useEffect(() => {
    if (previousRetryKey.current === retryKey) return;
    previousRetryKey.current = retryKey;
    if (failed) setRetryEpoch((epoch) => epoch + 1);
  }, [retryKey, failed]);

  const resolveImage = async (cacheMiss = false) => {
    if (pendingRequest.current !== null) return;
    if (!cacheMiss) onImageError?.();
    if (!cacheMiss && loadAttempt > 0) {
      setFailed(true);
      return;
    }

    if (imagePath && (cacheMiss || isR2Path(imagePath))) {
      const requestId = ++retryRequestId.current;
      pendingRequest.current = requestId;
      try {
        const freshUrl = cacheMiss
          ? (await withPublicShopImages<PublicImagePathItem>([{ image_path: imagePath }]))[0]?.image_url
          : await refreshR2CatalogObjectUrl('shop-images', imagePath);
        if (!isMounted.current || retryRequestId.current !== requestId) return;
        if (freshUrl) {
          if (!cacheMiss) setLoadAttempt((prev) => prev + 1);
          setCurrentUrl(freshUrl);
          return;
        }
      } catch {
        // Fall back to placeholder if re-signing fails
      } finally {
        if (pendingRequest.current === requestId) pendingRequest.current = null;
      }
      if (isMounted.current && retryRequestId.current === requestId) {
        setFailed(true);
      }
      return;
    }

    setFailed(true);
  };

  if ((!currentUrl && !imagePath) || failed) {
    return <>{fallback}</>;
  }

  if (renderImage) {
    return <>{currentUrl ? renderImage(currentUrl, () => void resolveImage()) : fallback}</>;
  }

  return (
    <CachedCatalogImage
      namespace="shop-images"
      imagePath={imagePath}
      fallback={fallback}
      alt={alt}
      aria-hidden={alt ? undefined : 'true'}
      className={className}
      decoding={decoding}
      key={`${currentUrl}:${loadAttempt}:${retryEpoch}`}
      loading={loading}
      onCacheMiss={() => void resolveImage(true)}
      onError={() => void resolveImage()}
      onLoad={onImageLoaded}
      src={currentUrl ?? undefined}
    />
  );
}
