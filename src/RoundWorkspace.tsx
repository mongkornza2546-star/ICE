import { useEffect, useMemo, useState } from 'react';
import { ManagerRoundControl } from './ManagerRoundControl';
import { ManagerStockControl } from './ManagerStockControl';
import { useReferenceData } from './hooks/useReferenceData';

export function todayIsoDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export function RoundWorkspace({ isActive }: { isActive: boolean }) {
  const {
    rounds,
    selectedRoundId,
    setSelectedRoundId,
    loadingRounds,
    workspaceError,
    loadReferenceData,
  } = useReferenceData(false);

  const [stockServiceDate] = useState(todayIsoDate());


  useEffect(() => {
    if (!isActive) return;
    void loadReferenceData();
  }, [isActive, loadReferenceData]);

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
  if (loadingRounds) {
    return (
      <section className="panel center-panel">
        <p className="eyebrow">กำลังโหลดข้อมูลงาน</p>
        <h2>ดึงข้อมูลงานและชนิดน้ำแข็ง</h2>
      </section>
    );
  }

  return (
    <div className="workspace-grid" style={{ gridTemplateColumns: '1fr' }}>
      {workspaceError ? (
        <section className="panel error-panel">
          <p className="eyebrow">มีข้อผิดพลาด</p>
          <h2>{workspaceError}</h2>
        </section>
      ) : null}
      <section className="stack stack--wide">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {legacyOpenRounds.length > 0 ? (
              <section className="panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">ข้อมูลเดิมก่อนเปลี่ยนระบบ</p>
                    <h2>รายการเดิมที่ต้องจัดการก่อนปิดสต๊อก</h2>
                  </div>
                  <span className="status-badge status-badge--warning">{legacyOpenRounds.length} รายการ</span>
                </div>
                <p className="muted">ปิดหรือยกเลิกรายการเดิมให้เรียบร้อยก่อนปิดสต๊อกของวันนี้</p>
                <div className="round-list">
                  {legacyOpenRounds.map((round) => (
                    <button
                      className={`round-item ${round.id === selectedLegacyRound?.id ? 'round-item--selected' : ''}`}
                      key={round.id}
                      onClick={() => setSelectedRoundId(round.id)}
                      type="button"
                    >
                      <span>{round.name} — กำลังดำเนินการ</span>
                      <small>{round.service_date} · เริ่ม {formatRoundTime(round.opened_at)}</small>
                    </button>
                  ))}
                </div>
                <div className="manager-section-divider" />
                <ManagerRoundControl
                  onCancelled={loadReferenceData}
                  onClosed={loadReferenceData}
                  round={selectedLegacyRound}
                />
              </section>
            ) : null}
            <ManagerStockControl operationRound={stockRound?.status === 'open' ? stockRound : null} round={stockRound} serviceDate={stockServiceDate} />
        </div>
      </section>
    </div>
  );
}

function formatRoundTime(value?: string | null) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
