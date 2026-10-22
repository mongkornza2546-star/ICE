import { CachedCatalogImage } from '../../CachedCatalogImage';
import { translateUi, useLanguage } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise } from '@phosphor-icons/react';
import { isR2Path, refreshR2CatalogObjectUrl } from '../../lib/r2Storage';
import type { IceTypeOption } from '../../types/app';

export function EmployeeStockProductImage({ iceType, onPreview }: {
  iceType: IceTypeOption;
  onPreview: (image: { name: string; url: string; imagePath?: string | null }) => void;
}) {
  useLanguage();
  const [url, setUrl] = useState(iceType.image_url ?? null);
  const [status, setStatus] = useState<'ready' | 'refreshing' | 'failed'>('ready');
  const [attempt, setAttempt] = useState(0);
  const displayedUrl = useRef<string | null>(null);
  const retried = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const retry = async () => {
    if (pending.current) return;
    pending.current = true;
    retried.current = true;
    setStatus('refreshing');
    try {
      const nextUrl = iceType.image_path && isR2Path(iceType.image_path)
        ? await refreshR2CatalogObjectUrl('ice-type-images', iceType.image_path)
        : iceType.image_url;
      if (!mounted.current) return;
      setUrl(nextUrl ?? null);
      setAttempt((current) => current + 1);
      setStatus(nextUrl ? 'ready' : 'failed');
    } catch {
      if (mounted.current) setStatus('failed');
    } finally {
      pending.current = false;
    }
  };

  if (status !== 'ready' || (!url && !iceType.image_path)) {
    return <button
      aria-label={translateUi('โหลดรูป {0} ใหม่', { 0: iceType.name })}
      className="employee-stock-product-image-button"
      disabled={status === 'refreshing'}
      onClick={() => void retry()}
      type="button"
    >
      <span className="employee-stock-product-image-retry">
        <ArrowClockwise aria-hidden="true" size={22} />
        <small>{status === 'refreshing' ? translateUi('กำลังโหลดรูป…') : translateUi('โหลดรูปใหม่')}</small>
      </span>
    </button>;
  }

  return <button
    aria-label={translateUi('ดูรูป {0} ขนาดใหญ่', { 0: iceType.name })}
    className="employee-stock-product-image-button"
    onClick={() => {
      const previewUrl = url ?? displayedUrl.current;
      if (previewUrl) onPreview({ name: iceType.name, url: previewUrl, imagePath: iceType.image_path });
      else void retry();
    }}
    type="button"
  >
    <CachedCatalogImage
      namespace="ice-type-images"
      imagePath={iceType.image_path}
      fallback={<span className="employee-stock-product-image-retry"><ArrowClockwise aria-hidden="true" size={22} /><small>{translateUi('โหลดรูปใหม่')}</small></span>}
      onLoad={(event) => { displayedUrl.current = event.currentTarget.src; }}
      alt={iceType.name}
      className="employee-stock-product-image"
      decoding="async"
      key={attempt}
      loading="lazy"
      onError={() => {
        if (retried.current) setStatus('failed');
        else void retry();
      }}
      src={url ?? undefined}
    />
  </button>;
}
