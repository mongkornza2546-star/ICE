import type { ReactNode } from 'react';

/**
 * Wrapper that keeps its children mounted once rendered,
 * but hides them with display:none when not active.
 * This preserves component state (fetched data, scroll position, form input)
 * across tab switches without re-mounting / re-fetching.
 */
export function KeepAlive({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div style={{ display: active ? undefined : 'none' }}>
      {children}
    </div>
  );
}

