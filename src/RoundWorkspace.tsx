import { useEffect, useMemo, useState } from 'react';
import { ManagerRoundControl } from './ManagerRoundControl';
import { ManagerStockControl } from './ManagerStockControl';
import { ManagerDeliveryAdjustments } from './ManagerDeliveryAdjustments';
import { useReferenceData } from './hooks/useReferenceData';

export function todayIsoDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export function RoundWorkspace({ mode }: { mode: 'manager' | 'stock' }) {
  const {
    rounds,
    selectedRoundId,
    setSelectedRoundId,
    loadingRounds,
    workspaceError,
    loadReferenceData,
  } = useReferenceData(false);

  const [stockServiceDate, setStockServiceDate] = useState(todayIsoDate());

  useEffect(() => {
    void loadReferenceData();
  }, [loadReferenceData]);

  const selectedRound = useMemo(
    () => rounds.find((round) => round.id === selectedRoundId) ?? null,
    [rounds, selectedRoundId],
  );
  const stockRound = selectedRound?.service_date === stockServiceDate && !selectedRound.cancelled_at
    ? selectedRound
    : null;
  const stockOperationRound = useMemo(
    () => (stockRound?.status === 'open' ? stockRound : null)
      ?? rounds.find((round) => round.service_date === stockServiceDate && round.status === 'open')
      ?? rounds.find((round) => round.service_date === stockServiceDate && !round.cancelled_at)
      ?? null,
    [rounds, stockRound, stockServiceDate],
  );
  const visibleRounds = useMemo(
    () => mode === 'stock' ? rounds.filter((round) => !round.cancelled_at) : rounds,
    [mode, rounds],
  );

  if (loadingRounds) {
    return (
      <section className="panel center-panel">
        <p className="eyebrow">กำลังโหลดข้อมูลรอบ</p>
          <h2>ดึงรอบส่งและชนิดน้ำแข็ง</h2>
      </section>
    );
  }

  return (
    <div className="workspace-grid" style={mode === 'stock' && !workspaceError ? { gridTemplateColumns: '1fr' } : undefined}>
      {(mode === 'manager' || workspaceError) && (
        <section className="stack">
          {mode === 'manager' && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">งานที่เข้าถึงได้</p>
                  <h2>ติดตามงานประจำวัน</h2>
                </div>
              </div>
              <div className="round-list">
                {visibleRounds.map((round) => (
                  <button
                    className={`round-item ${round.id === selectedRoundId ? 'round-item--selected' : ''}`}
                    key={round.id}
                    onClick={() => {
                      setSelectedRoundId(round.id);
                    }}
                    type="button"
                  >
                    <span>{round.name} — {roundStatusLabel(round)}</span>
                    <small>
                      {round.service_date} · เริ่ม {formatRoundTime(round.opened_at)}
                      {round.cancelled_at
                        ? ` · ยกเลิก ${formatRoundTime(round.cancelled_at)}`
                        : round.status === 'closed' ? ` · ปิด ${formatRoundTime(round.closed_at)}` : ''}
                    </small>
                  </button>
                ))}
                {visibleRounds.length === 0 ? (
                  <p className="empty-text">ยังไม่มีงานประจำวัน งานจะเปิดอัตโนมัติเมื่อบันทึกคำสั่งจากโรงงานครั้งแรก</p>
                ) : null}
              </div>
            </section>
          )}

          {workspaceError ? (
            <section className="panel error-panel">
              <p className="eyebrow">มีข้อผิดพลาด</p>
              <h2>{workspaceError}</h2>
            </section>
          ) : null}
        </section>
      )}

      <section className="stack stack--wide">
        {mode === 'manager' ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">หัวหน้ารอบ</p>
                <h2>{selectedRound ? `${selectedRound.name} · ${selectedRound.service_date}` : 'เลือกรอบส่งก่อน'}</h2>
              </div>
            </div>
            <ManagerRoundControl
              onCancelled={async () => {
                await loadReferenceData();
              }}
              onClosed={async () => {
                await loadReferenceData();
              }}
              round={selectedRound}
            />
            <div className="manager-section-divider" />
            <ManagerDeliveryAdjustments round={selectedRound} />
          </section>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <ManagerStockControl operationRound={stockOperationRound} round={stockRound} serviceDate={stockServiceDate} />
          </div>
        )}
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

function roundStatusLabel(round: { status: 'open' | 'closed'; cancelled_at?: string | null }) {
  if (round.cancelled_at) return 'ยกเลิกแล้ว';
  return round.status === 'open' ? 'เปิดอยู่' : 'ปิดแล้ว';
}
