import { uiDateTimeFormat, translateUi, useLanguage } from './i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ManagerRoundControl } from './ManagerRoundControl';
import { ManagerStockControl } from './ManagerStockControl';
import { useReferenceData } from './hooks/useReferenceData';
import { subscribeToDataChange } from './lib/dataChange';
import { useBangkokServiceDate } from './hooks/useBangkokServiceDate';
import { toBangkokDateString } from './lib/serviceDate';

export function todayIsoDate() {
  return toBangkokDateString();
}

export function RoundWorkspace({ isActive }: { isActive: boolean }) {
  useLanguage();
  const {
    rounds,
    selectedRoundId,
    setSelectedRoundId,
    loadingRounds,
    workspaceError,
    loadReferenceData,
  } = useReferenceData(false);

  const stockServiceDate = useBangkokServiceDate();
  const [stockRefreshId, setStockRefreshId] = useState(0);
  const refreshWorkspace = useCallback(async () => {
    await loadReferenceData();
    setStockRefreshId((current) => current + 1);
  }, [loadReferenceData]);

  useEffect(() => {
    if (!isActive) return;
    void refreshWorkspace();
  }, [isActive, refreshWorkspace, stockServiceDate]);

  useEffect(() => subscribeToDataChange(['stock'], () => { if (isActive) void refreshWorkspace(); }), [isActive, refreshWorkspace]);

  const stockRound = useMemo(
    () => rounds.find((round) => (
      round.service_date === stockServiceDate
      && round.round_type === 'daily'
      && !round.cancelled_at
    )) ?? null,
    [rounds, stockServiceDate],
  );
  const legacyOpenRounds = useMemo(
    () => rounds.filter((round) => round.round_type === 'special' && round.status === 'open' && !round.cancelled_at),
    [rounds],
  );
  const selectedLegacyRound = useMemo(
    () => legacyOpenRounds.find((round) => round.id === selectedRoundId) ?? legacyOpenRounds[0] ?? null,
    [legacyOpenRounds, selectedRoundId],
  );
  if (loadingRounds && rounds.length === 0 && stockRefreshId === 0) {
    return (
      <section className="panel center-panel">
        <p className="eyebrow">{translateUi('กำลังโหลดข้อมูลงาน')}</p>
        <h2>{translateUi('ดึงข้อมูลงานและชนิดน้ำแข็ง')}</h2>
      </section>
    );
  }

  return (
    <div className="workspace-grid" style={{ gridTemplateColumns: '1fr' }}>
      {workspaceError ? (
        <section className="panel error-panel">
          <p className="eyebrow">{translateUi('มีข้อผิดพลาด')}</p>
          <h2>{translateUi(workspaceError)}</h2>
        </section>
      ) : null}
      <section className="stack stack--wide">
        <p className="muted" role="status">{translateUi('วันที่ทำรายการสต๊อก ')}{stockServiceDate}{translateUi(' (เวลาไทย)')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {legacyOpenRounds.length > 0 ? (
              <section className="panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">{translateUi('ข้อมูลเดิมก่อนเปลี่ยนระบบ')}</p>
                    <h2>{translateUi('รายการเดิมที่ต้องจัดการก่อนปิดสต๊อก')}</h2>
                  </div>
                  <span className="status-badge status-badge--warning">{legacyOpenRounds.length}{translateUi(' รายการ')}</span>
                </div>
                <p className="muted">{translateUi('ปิดหรือยกเลิกรายการเดิมให้เรียบร้อยก่อนปิดสต๊อกของวันนี้')}</p>
                <div className="round-list">
                  {legacyOpenRounds.map((round) => (
                    <button
                      className={`round-item ${round.id === selectedLegacyRound?.id ? 'round-item--selected' : ''}`}
                      key={round.id}
                      onClick={() => setSelectedRoundId(round.id)}
                      type="button"
                    >
                      <span>{round.name}{translateUi(' — กำลังดำเนินการ')}</span>
                      <small>{round.service_date}{translateUi(' · เริ่ม ')}{formatRoundTime(round.opened_at)}</small>
                    </button>
                  ))}
                </div>
                <div className="manager-section-divider" />
                <ManagerRoundControl
                  onCancelled={refreshWorkspace}
                  onClosed={refreshWorkspace}
                  round={selectedLegacyRound}
                />
              </section>
            ) : null}
            <ManagerStockControl key={stockServiceDate} operationRound={stockRound?.status === 'open' ? stockRound : null} refreshId={stockRefreshId} round={stockRound} serviceDate={stockServiceDate} />
        </div>
      </section>
    </div>
  );
}

function formatRoundTime(value?: string | null) {
  if (!value) return '-';
  return uiDateTimeFormat({
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
