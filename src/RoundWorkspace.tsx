import { FormEvent, useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import { ManagerRoundControl } from './ManagerRoundControl';
import { ManagerStockControl } from './ManagerStockControl';
import { ManagerDeliveryAdjustments } from './ManagerDeliveryAdjustments';
import { useReferenceData } from './hooks/useReferenceData';
import type { UserProfile } from './types/app';

const ROLE_LABELS = {
  courier: 'พนักงานส่ง',
  round_lead: 'หัวหน้ารอบ',
  admin: 'แอดมิน',
} as const;

interface RoundCreationDraft {
  serviceDate: string;
  name: string;
  memberIds: string[];
}

export function todayIsoDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export function RoundWorkspace({ profile, mode }: { profile: UserProfile; mode: 'manager' | 'stock' }) {
  const canCreateRound = profile.role === 'admin' || profile.role === 'round_lead';

  const {
    rounds,
    iceTypes,
    roundNameOptions,
    memberOptions,
    selectedRoundId,
    setSelectedRoundId,
    loadingRounds,
    workspaceError,
    loadReferenceData,
  } = useReferenceData(canCreateRound);

  const [createError, setCreateError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);
  const [stockServiceDate, setStockServiceDate] = useState(todayIsoDate());
  const [roundDraft, setRoundDraft] = useState<RoundCreationDraft>({
    serviceDate: todayIsoDate(),
    name: '',
    memberIds: [],
  });

  useEffect(() => {
    void loadReferenceData();
  }, [loadReferenceData]);

  useEffect(() => {
    setRoundDraft((current) => ({
      ...current,
      memberIds:
        current.memberIds.length > 0
          ? current.memberIds
          : canCreateRound && profile.role === 'round_lead'
            ? [profile.id]
            : current.memberIds,
    }));
  }, [canCreateRound, profile.id, profile.role]);

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

  const handleCreateRound = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) {
      return;
    }

    setCreateLoading(true);
    setCreateError(null);

    const payload = iceTypes.map((iceType) => ({
      ice_type_id: iceType.id,
      quantity: 0,
    }));

    const { data, error } = await supabase.rpc('create_delivery_round', {
      p_service_date: roundDraft.serviceDate,
      p_name: roundDraft.name,
      p_member_ids: roundDraft.memberIds,
      p_loaded_quantities: payload,
    });

    if (error) {
      setCreateError(error.message);
      setCreateLoading(false);
      return;
    }

    const newRoundId = data as string;
    setRoundDraft((current) => ({
      ...current,
      name: '',
    }));
    await loadReferenceData();
    setSelectedRoundId(newRoundId);
    setCreateLoading(false);
  };

  if (loadingRounds) {
    return (
      <section className="panel center-panel">
        <p className="eyebrow">กำลังโหลดข้อมูลรอบ</p>
          <h2>ดึงรอบส่งและชนิดน้ำแข็ง</h2>
      </section>
    );
  }

  return (
    <div className="workspace-grid">
      <section className="stack">
        {canCreateRound && mode === 'manager' ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">หัวหน้ารอบ</p>
                <h2>เปิดรอบส่งใหม่</h2>
              </div>
            </div>
            <form className="round-form" onSubmit={handleCreateRound}>
              <div className="field-grid">
                <label>
                  วันที่ให้บริการ
                  <input
                    type="date"
                    value={roundDraft.serviceDate}
                    onChange={(event) =>
                      setRoundDraft((current) => ({
                        ...current,
                        serviceDate: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  ชื่อรอบ
                  <select
                    value={roundDraft.name}
                    onChange={(event) =>
                      setRoundDraft((current) => ({ ...current, name: event.target.value }))
                    }
                    required
                  >
                    <option value="" disabled>เลือกรอบจากตั้งค่า</option>
                    {roundNameOptions.map((option) => (
                      <option key={option.id} value={option.name}>{option.name}</option>
                    ))}
                  </select>
                </label>
              </div>

              <fieldset className="fieldset">
                <legend>ผู้ร่วมรอบ</legend>
                <div className="chip-grid">
                  {memberOptions.map((member) => {
                    const checked = roundDraft.memberIds.includes(member.id);
                    return (
                      <label
                        className={`choice-chip ${checked ? 'choice-chip--selected' : ''}`}
                        key={member.id}
                      >
                        <input
                          checked={checked}
                          hidden
                          onChange={() =>
                            setRoundDraft((current) => ({
                              ...current,
                              memberIds: checked
                                ? current.memberIds.filter((memberId) => memberId !== member.id)
                                : [...current.memberIds, member.id],
                            }))
                          }
                          type="checkbox"
                        />
                        <span>{member.display_name}</span>
                        <small>{ROLE_LABELS[member.role]}</small>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {createError ? <p className="error-text">{createError}</p> : null}
              <button
                className="primary-button"
                disabled={createLoading || roundDraft.memberIds.length === 0 || !roundDraft.name}
                type="submit"
              >
                {createLoading ? 'กำลังเปิดรอบ...' : 'เปิดรอบส่ง'}
              </button>
              {roundNameOptions.length === 0 ? <p className="error-text">ยังไม่มีชื่อรอบที่เปิดใช้งาน กรุณาตั้งค่าชื่อรอบก่อน</p> : null}
              <p className="muted">รอบใช้จัดกลุ่มผู้ปฏิบัติงานและรายการขายเท่านั้น น้ำแข็งจากโรงงานและการส่งมอบบันทึกในสต๊อกต่อเนื่องทั้งวัน</p>
            </form>
          </section>
        ) : null}

        {mode === 'stock' ? (
          <section className="panel left-panel-custom">
            <div className="panel-header" style={{ marginBottom: 16 }}>
              <h3 className="stock-layout-title">
                เลือกรอบขนส่ง
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
              </h3>
            </div>
            <div className="round-list" style={{ gap: 12, padding: 0, border: 'none', background: 'transparent' }}>
              <button
                className={`round-item-custom ${stockRound === null ? 'selected' : ''}`}
                onClick={() => setSelectedRoundId('')}
                type="button"
              >
                <div className="round-item-custom-header">
                  <span>ตลอดวัน</span>
                  <span className="status-badge-custom open">เปิดอยู่</span>
                </div>
                <div className="round-item-custom-date">
                  {stockServiceDate}
                </div>
              </button>
              {visibleRounds.map((round) => (
                <button
                  className={`round-item-custom ${round.id === selectedRoundId ? 'selected' : ''}`}
                  key={round.id}
                  onClick={() => {
                    setSelectedRoundId(round.id);
                    if (mode === 'stock') setStockServiceDate(round.service_date);
                  }}
                  type="button"
                >
                  <div className="round-item-custom-header">
                    <span>{round.name}</span>
                    <span className={`status-badge-custom ${round.status === 'open' && !round.cancelled_at ? 'open' : 'closed'}`}>
                      {roundStatusLabel(round)}
                    </span>
                  </div>
                  <div className="round-item-custom-date">
                    {new Date(round.service_date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </div>
                </button>
              ))}
              {visibleRounds.length === 0 ? (
                <p className="empty-text">ยังไม่มีรอบส่งที่บัญชีนี้เข้าถึงได้</p>
              ) : null}
            </div>

            {stockRound && (
              <div className="selected-round-card">
                <h4>รอบที่เลือก</h4>
                <div className="round-item-custom-header" style={{ marginBottom: 12 }}>
                  <span style={{ fontSize: '1.2rem' }}>{stockRound.name}</span>
                  <span className={`status-badge-custom ${stockRound.status === 'open' && !stockRound.cancelled_at ? 'open' : 'closed'}`}>
                    {roundStatusLabel(stockRound)}
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">วันที่</span>
                  <span>{new Date(stockRound.service_date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">ศูนย์</span>
                  <span>ศูนย์ราชการ</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">เริ่มรอบ</span>
                  <span>{formatRoundTime(stockRound.opened_at)} น.</span>
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">รอบที่เข้าถึงได้</p>
                <h2>เลือกรอบส่ง</h2>
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
                <p className="empty-text">ยังไม่มีรอบส่งที่บัญชีนี้เข้าถึงได้</p>
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
