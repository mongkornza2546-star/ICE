import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise } from '@phosphor-icons/react';
import { isR2Path, refreshR2CatalogObjectUrl } from '../../lib/r2Storage';
import type { IceTypeOption } from '../../types/app';

export function EmployeeStockProductImage({ iceType, onPreview }: {
  iceType: IceTypeOption;
  onPreview: (image: { name: string; url: string }) => void;
}) {
  const [url, setUrl] = useState(iceType.image_url ?? null);
  const [status, setStatus] = useState<'ready' | 'refreshing' | 'failed'>('ready');
  const [attempt, setAttempt] = useState(0);
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

  if (status !== 'ready' || !url) {
    return <button
      aria-label={`โหลดรูป ${iceType.name} ใหม่`}
      className="employee-stock-product-image-button"
      disabled={status === 'refreshing'}
      onClick={() => void retry()}
      type="button"
    >
      <span className="employee-stock-product-image-retry">
        <ArrowClockwise aria-hidden="true" size={22} />
        <small>{status === 'refreshing' ? 'กำลังโหลดรูป…' : 'โหลดรูปใหม่'}</small>
      </span>
    </button>;
  }

  return <button
    aria-label={`ดูรูป ${iceType.name} ขนาดใหญ่`}
    className="employee-stock-product-image-button"
    onClick={() => onPreview({ name: iceType.name, url })}
    type="button"
  >
    <img
      alt={iceType.name}
      className="employee-stock-product-image"
      decoding="async"
      key={attempt}
      loading="lazy"
      onError={() => {
        if (retried.current) setStatus('failed');
        else void retry();
      }}
      src={url}
    />
  </button>;
}
