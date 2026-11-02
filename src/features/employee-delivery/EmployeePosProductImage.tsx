import { useEffect, useRef, useState } from 'react';
import { IceCream } from '@phosphor-icons/react';
import { CachedCatalogImage } from '../../CachedCatalogImage';
import { getR2ObjectUrl, isR2Path, refreshR2CatalogObjectUrl } from '../../lib/r2Storage';

interface Props {
  imageUrl?: string | null;
  imagePath?: string | null;
}

export function EmployeePosProductImage(props: Props) {
  // A catalog update starts a new attempt and cannot receive an old URL reply.
  return <ProductImage key={JSON.stringify([props.imagePath, props.imageUrl])} {...props} />;
}

function ProductImage({ imageUrl, imagePath }: Props) {
  const [url, setUrl] = useState(imageUrl ?? null);
  const [status, setStatus] = useState<'ready' | 'refreshing' | 'failed'>('ready');
  const retried = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const recover = async (forceRefresh: boolean) => {
    if (pending.current) return;
    if (retried.current || !imagePath || !isR2Path(imagePath)) {
      setStatus('failed');
      return;
    }
    // Missing image bytes do not mean the cached signed URL is invalid.
    // Keep the forced refresh available if that URL subsequently fails.
    if (forceRefresh) retried.current = true;
    pending.current = true;
    setStatus('refreshing');
    try {
      const nextUrl = await (forceRefresh ? refreshR2CatalogObjectUrl : getR2ObjectUrl)('ice-type-images', imagePath);
      if (!mounted.current) return;
      setUrl(nextUrl);
      setStatus(nextUrl ? 'ready' : 'failed');
    } catch {
      if (mounted.current) setStatus('failed');
    } finally {
      pending.current = false;
    }
  };

  const fallback = <span className="employee-pos-product-image"><IceCream aria-hidden="true" /></span>;
  if (status !== 'ready' || (!url && !imagePath)) return fallback;
  return <CachedCatalogImage
    namespace="ice-type-images"
    imagePath={imagePath}
    src={url ?? undefined}
    alt=""
    className="employee-pos-product-image"
    fallback={fallback}
    onCacheMiss={() => void recover(false)}
    onError={() => void recover(true)}
  />;
}
