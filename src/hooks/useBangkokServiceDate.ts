import { useEffect, useState } from 'react';
import { toBangkokDateString } from '../lib/serviceDate';

/** Keeps a mounted operational screen on the current Bangkok business day. */
export function useBangkokServiceDate() {
  const [serviceDate, setServiceDate] = useState(() => toBangkokDateString());
  useEffect(() => {
    const refresh = () => setServiceDate(toBangkokDateString());
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return serviceDate;
}
