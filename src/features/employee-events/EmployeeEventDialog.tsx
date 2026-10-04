import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from '@phosphor-icons/react';

export function EmployeeEventDialog({ title, context, busy, onClose, onSubmit, children, submitLabel }: {
  title: string;
  context: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  children: ReactNode;
  submitLabel: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const current = useRef({ busy, onClose });
  current.current = { busy, onClose };
  const [viewport, setViewport] = useState<{ top: number; height: number }>();

  useLayoutEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const siblings = Array.from(document.body.children).filter((node): node is HTMLElement => (
      node instanceof HTMLElement && node !== layerRef.current
    )).map((node) => ({ node, inert: node.inert, ariaHidden: node.getAttribute('aria-hidden') }));
    siblings.forEach(({ node }) => { node.inert = true; node.setAttribute('aria-hidden', 'true'); });
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLElement>('[data-initial-focus]') ?? dialog)?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!current.current.busy) current.current.onClose();
      }
      if (event.key !== 'Tab' || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
      )).filter((node) => !node.closest('details:not([open])') || node.tagName === 'SUMMARY');
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      siblings.forEach(({ node, inert, ariaHidden }) => {
        node.inert = inert;
        if (ariaHidden === null) node.removeAttribute('aria-hidden');
        else node.setAttribute('aria-hidden', ariaHidden);
      });
      // Wait for React to re-enable the trigger after the save completes.
      queueMicrotask(() => { if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true }); });
    };
  }, []);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) return;
    const update = () => setViewport({ top: visualViewport.offsetTop, height: visualViewport.height });
    update();
    visualViewport.addEventListener('resize', update);
    visualViewport.addEventListener('scroll', update);
    return () => {
      visualViewport.removeEventListener('resize', update);
      visualViewport.removeEventListener('scroll', update);
    };
  }, []);

  return createPortal(
    <div className="employee-event-dialog" ref={layerRef} style={viewport ? { top: viewport.top, height: viewport.height, bottom: 'auto' } : undefined}>
      <div aria-hidden="true" className="employee-event-dialog__backdrop" onClick={() => { if (!busy) onClose(); }} />
      <form aria-labelledby={titleId} aria-modal="true" className="employee-event-dialog__panel" onSubmit={onSubmit} ref={dialogRef} role="dialog" tabIndex={-1}>
        <header><div><p>{context}</p><h2 id={titleId}>{title}</h2></div><button aria-label="ปิดหน้าต่าง" disabled={busy} onClick={onClose} type="button"><X size={22} /></button></header>
        <div className="employee-event-dialog__body">{children}</div>
        <footer><button className="secondary-button" disabled={busy} onClick={onClose} type="button">ยกเลิก</button><button className="primary-button" disabled={busy} type="submit">{busy ? 'กำลังบันทึก…' : submitLabel}</button></footer>
      </form>
    </div>, document.body,
  );
}
