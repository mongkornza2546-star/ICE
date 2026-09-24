import React, { useEffect, useRef, useState } from 'react';
import { isR2Path, refreshR2CatalogObjectUrl } from '../../../lib/r2Storage';

export interface AutoRefreshShopImageProps {
  imageUrl?: string | null;
  imagePath?: string | null;
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
  const retryRequestId = useRef(0);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    retryRequestId.current += 1;
    setCurrentUrl(imageUrl ?? null);
    setLoadAttempt(0);
    setFailed(false);
  }, [imageUrl, imagePath]);

  const handleImageError = async () => {
    onImageError?.();
    if (loadAttempt > 0) {
      setFailed(true);
      return;
    }

    if (imagePath && isR2Path(imagePath)) {
      const requestId = ++retryRequestId.current;
      try {
        const freshUrl = await refreshR2CatalogObjectUrl('shop-images', imagePath);
        if (!isMounted.current || retryRequestId.current !== requestId) return;
        if (freshUrl) {
          setLoadAttempt((prev) => prev + 1);
          setCurrentUrl(freshUrl);
          return;
        }
      } catch {
        // Fall back to placeholder if re-signing fails
      }
      if (isMounted.current && retryRequestId.current === requestId) {
        setFailed(true);
      }
      return;
    }

    setFailed(true);
  };

  if (!currentUrl || failed) {
    return <>{fallback}</>;
  }

  if (renderImage) {
    return <>{renderImage(currentUrl, () => void handleImageError())}</>;
  }

  return (
    <img
      alt={alt}
      aria-hidden={alt ? undefined : 'true'}
      className={className}
      decoding={decoding}
      key={`${currentUrl}:${loadAttempt}`}
      loading={loading}
      onError={() => void handleImageError()}
      onLoad={onImageLoaded}
      src={currentUrl}
    />
  );
}
