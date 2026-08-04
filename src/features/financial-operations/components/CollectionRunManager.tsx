import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle,
  Clock,
  Plus,
  UserCircle,
  UsersThree,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import type { Collector } from '../types';

const runTime = new Intl.DateTimeFormat('th-TH', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Bangkok',
});

function collectorName(collector: Collector) {
  if (collector.nickname && collector.nickname !== collector.display_name) {
    return `${collector.nickname} (${collector.display_name})`;
  }
  return collector.display_name;
}

export function CollectionRunManager({
  runId,
  openedAt,
  busy,
  collectors,
  collectorAvatarUrls,
  failedCollectorAvatars,
  memberIds,
  onCloseRun,
  onCollectorAvatarError,
  onOpenRun,
}: {
  runId: string | null;
  openedAt: string | null;
  busy: boolean;
  collectors: Collector[];
  collectorAvatarUrls: Record<string, string>;
  failedCollectorAvatars: Set<string>;
  memberIds: string[];
  onCloseRun: () => void;
  onCollectorAvatarError: (path: string) => void;
  onOpenRun: (memberIds: string[]) => Promise<boolean>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [draftMemberIds, setDraftMemberIds] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const focusActiveButtonRef = useRef(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const activeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const activeCollectorNames = useMemo(() => collectors
    .filter((collector) => memberIds.includes(collector.id))
    .map(collectorName), [collectors, memberIds]);
  const activeCollectorLabel = activeCollectorNames.length > 0
    ? activeCollectorNames.join(', ')
    : memberIds.length > 0 ? `พนักงาน ${memberIds.length} คน` : 'ยังไม่พบชื่อผู้รับผิดชอบ';
  const openedTimeLabel = openedAt ? runTime.format(new Date(openedAt)) : '—';

  const closeModal = () => {
    if (confirming) return;
    setModalOpen(false);
  };

  useEffect(() => {
    if (!modalOpen) return;
    const page = document.querySelector<HTMLElement>('.financial-ops');
    const previousOverflow = document.body.style.overflow;
    const closeOnKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !confirmingRef.current) {
        setModalOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    if (page) page.inert = true;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    window.addEventListener('keydown', closeOnKeydown);
    return () => {
      if (page) page.inert = false;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnKeydown);
      if (focusActiveButtonRef.current) {
        focusActiveButtonRef.current = false;
        activeButtonRef.current?.focus();
      } else {
        openButtonRef.current?.focus();
      }
    };
  }, [modalOpen]);

  const showModal = () => {
    setDraftMemberIds(memberIds);
    setModalOpen(true);
  };

  const confirmOpenRun = async () => {
    if (draftMemberIds.length === 0 || confirming) return;
    confirmingRef.current = true;
    setConfirming(true);
    const saved = await onOpenRun(draftMemberIds);
    confirmingRef.current = false;
    setConfirming(false);
    if (saved) {
      focusActiveButtonRef.current = true;
      setModalOpen(false);
    }
  };

  return <>
    {runId ? (
      <section aria-label="สถานะรอบเก็บเงิน" className="collection-run-status collection-run-status--active">
        <span className="collection-run-status__icon"><CheckCircle aria-hidden="true" size={24} weight="fill" /></span>
        <div className="collection-run-status__copy">
          <span>รอบปัจจุบัน: <strong>{activeCollectorLabel}</strong></span>
          <small><Clock aria-hidden="true" size={14} />เริ่ม {openedTimeLabel} น.</small>
        </div>
        <button disabled={busy} onClick={onCloseRun} ref={activeButtonRef} type="button">ปิดรอบเก็บเงิน</button>
      </section>
    ) : (
      <section aria-label="สถานะรอบเก็บเงิน" className="collection-run-status collection-run-status--warning">
        <span className="collection-run-status__icon"><WarningCircle aria-hidden="true" size={24} weight="fill" /></span>
        <div className="collection-run-status__copy">
          <strong>ยังไม่ได้เปิดรอบเก็บเงินประจำวัน</strong>
          <small>เปิดรอบและเลือกพนักงานผู้รับผิดชอบก่อนเริ่มรับชำระเงิน</small>
        </div>
        <button disabled={busy} onClick={showModal} ref={openButtonRef} type="button"><Plus aria-hidden="true" size={17} weight="bold" />เปิดรอบและมอบหมาย</button>
      </section>
    )}

    {modalOpen ? createPortal(
      <div className="collection-run-modal">
        <button aria-label="ปิดหน้าต่างมอบหมายพนักงาน" className="collection-run-modal__backdrop" onClick={closeModal} tabIndex={-1} type="button" />
        <div aria-labelledby="collection-run-modal-title" aria-modal="true" className="collection-run-modal__card" ref={dialogRef} role="dialog">
          <header>
            <span><UsersThree aria-hidden="true" size={26} weight="duotone" /></span>
            <div>
              <h2 id="collection-run-modal-title">เปิดรอบเก็บเงินท้ายวัน</h2>
              <p>เลือกพนักงานผู้รับผิดชอบรอบนี้ แล้วกดยืนยันเพื่อเปิดรอบ</p>
            </div>
            <button aria-label="ปิดหน้าต่าง" disabled={confirming} onClick={closeModal} ref={closeButtonRef} type="button"><X aria-hidden="true" size={20} /></button>
          </header>

          <fieldset disabled={confirming}>
            <legend>พนักงานผู้เก็บเงิน</legend>
            <div className="collection-run-modal__collector-list">
              {collectors.map((collector) => (
                <label className="collection-run-modal__collector" key={collector.id}>
                  <input
                    checked={draftMemberIds.includes(collector.id)}
                    onChange={(event) => setDraftMemberIds((current) => event.target.checked
                      ? [...current, collector.id]
                      : current.filter((id) => id !== collector.id))}
                    type="checkbox"
                  />
                  <span className="financial-ops__collector-avatar" aria-hidden="true">
                    {collector.avatar_path
                      && collectorAvatarUrls[collector.avatar_path]
                      && !failedCollectorAvatars.has(collector.avatar_path) ? (
                        <img
                          alt=""
                          onError={() => onCollectorAvatarError(collector.avatar_path!)}
                          src={collectorAvatarUrls[collector.avatar_path]}
                        />
                      ) : <UserCircle size={32} weight="duotone" />}
                  </span>
                  <span className="financial-ops__collector-identity">
                    <strong>{collectorName(collector)}</strong>
                    <small>{collector.code}</small>
                  </span>
                </label>
              ))}
              {collectors.length === 0 ? <p>ไม่พบพนักงานที่สามารถมอบหมายได้</p> : null}
            </div>
          </fieldset>

          <footer>
            <span>เลือกแล้ว {draftMemberIds.length} คน</span>
            <div>
              <button disabled={confirming} onClick={closeModal} type="button">ยกเลิก</button>
              <button disabled={draftMemberIds.length === 0 || confirming} onClick={() => void confirmOpenRun()} type="button">
                {confirming ? 'กำลังเปิดรอบ…' : 'ยืนยันเปิดรอบ'}
              </button>
            </div>
          </footer>
        </div>
      </div>,
      document.body,
    ) : null}
  </>;
}
