import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ArrowsClockwise, X } from '@phosphor-icons/react';
import { translateUi } from '../../i18n';
import type { EmployeeRuntime } from './client';
import { OfflineStatus } from './OfflineStatus';
import { pendingCommand } from './types';

export function OfflineTools({ runtime }: { runtime: EmployeeRuntime }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const view = useSyncExternalStore(runtime.engine.subscribe, runtime.engine.getSnapshot);
  const attentionCount = view.commands.filter(command => pendingCommand(command) && (
    command.status === 'blocked' || command.status === 'conflict' || command.status === 'auth_required'
    || command.serviceDate !== runtime.engine.day
  )).length;
  const title = translateUi('ข้อมูลและรายการออฟไลน์');
  const attention = attentionCount ? `${translateUi('รายการต้องตรวจสอบ')} · ${attentionCount}` : '';
  const triggerLabel = attention ? `${title} · ${attention}` : title;
  return <>
    <button ref={trigger} className="employee-offline-trigger" type="button" aria-label={triggerLabel} title={triggerLabel} aria-haspopup="dialog"
      onClick={() => { setOpen(true); dialog.current?.showModal(); }}>
      <ArrowsClockwise aria-hidden="true" size={20} />
      {attentionCount ? <span className="employee-offline-badge" aria-hidden="true">{attentionCount > 99 ? '99+' : attentionCount}</span> : null}
    </button>
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{attention}</div>
    {createPortal(<dialog ref={dialog} className="employee-offline-dialog" aria-labelledby={titleId}
      onClose={() => { setOpen(false); trigger.current?.focus(); }}>
      <header>
        <h2 id={titleId}>{title}</h2>
        <button type="button" aria-label={translateUi('ปิด')} onClick={() => dialog.current?.close()}>
          <X aria-hidden="true" size={20} />
        </button>
      </header>
      {open ? <OfflineStatus runtime={runtime} /> : null}
    </dialog>, document.body)}
  </>;
}
