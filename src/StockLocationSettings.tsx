import { FormEvent, useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import type {
  BuildingOption,
  RoundMemberOption,
  StockLocationKind,
  StockLocationSetting,
} from './types/app';

const LOCATION_KINDS: Array<{ value: StockLocationKind; label: string }> = [
  { value: 'truck', label: 'รถบรรทุก' },
  { value: 'team', label: 'พนักงาน / ทีมส่ง' },
  { value: 'small_vehicle', label: 'รถเล็ก' },
  { value: 'work_site', label: 'จุดปฏิบัติงาน' },
  { value: 'reserve_bin', label: 'ถังสำรอง' },
  { value: 'front_vehicle', label: 'จุดหน้ารถ' },
];

const KIND_LABELS: Record<StockLocationKind, string> = {
  truck: 'รถบรรทุก',
  team: 'พนักงาน / ทีมส่ง',
  small_vehicle: 'รถเล็ก',
  work_site: 'จุดปฏิบัติงาน',
  reserve_bin: 'ถังสำรอง',
  front_vehicle: 'จุดหน้ารถ',
};

interface LocationDraft {
  id: string;
  code: string;
  name: string;
  kind: StockLocationKind;
  buildingId: string;
  assignedUserId: string;
  isCourierSource: boolean;
  isDefaultForBuilding: boolean;
  isActive: boolean;
}

const EMPTY_DRAFT: LocationDraft = {
  id: '',
  code: '',
  name: '',
  kind: 'team',
  buildingId: '',
  assignedUserId: '',
  isCourierSource: false,
  isDefaultForBuilding: false,
  isActive: true,
};

export function StockLocationSettings() {
  const [locations, setLocations] = useState<StockLocationSetting[]>([]);
  const [buildings, setBuildings] = useState<BuildingOption[]>([]);
  const [members, setMembers] = useState<RoundMemberOption[]>([]);
  const [draft, setDraft] = useState<LocationDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings();
  }, []);

  async function loadSettings(preferredId?: string) {
    if (!supabase) return;
    setLoading(true);
    const [locationsResponse, buildingsResponse, membersResponse] = await Promise.all([
      supabase
        .from('stock_locations')
        .select('id, code, name, kind, building_id, assigned_user_id, is_courier_source, is_default_for_building, is_active')
        .order('kind')
        .order('name'),
      supabase.from('buildings').select('id, code, name, is_active').order('code'),
      supabase.rpc('get_assignable_round_members'),
    ]);
    const firstError = locationsResponse.error ?? buildingsResponse.error ?? membersResponse.error;
    if (firstError) {
      setError(firstError.message);
    } else {
      const nextLocations = (locationsResponse.data ?? []) as StockLocationSetting[];
      setLocations(nextLocations);
      setBuildings((buildingsResponse.data ?? []) as BuildingOption[]);
      setMembers((membersResponse.data ?? []) as RoundMemberOption[]);
      if (preferredId) {
        const selected = nextLocations.find((location) => location.id === preferredId);
        if (selected) chooseLocation(selected);
      }
    }
    setLoading(false);
  }

  function chooseLocation(location: StockLocationSetting) {
    setDraft({
      id: location.id,
      code: location.code,
      name: location.name,
      kind: location.kind,
      buildingId: location.building_id ?? '',
      assignedUserId: location.assigned_user_id ?? '',
      isCourierSource: location.is_courier_source,
      isDefaultForBuilding: location.is_default_for_building,
      isActive: location.is_active,
    });
    setError(null);
    setSuccess(null);
  }

  async function saveLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    const { data, error: saveError } = await supabase.rpc('save_stock_location', {
      p_code: draft.code.trim(),
      p_name: draft.name.trim(),
      p_kind: draft.kind,
      p_location_id: draft.id || null,
      p_building_id: draft.buildingId || null,
      p_assigned_user_id: draft.assignedUserId || null,
      p_is_courier_source: draft.isCourierSource,
      p_is_default_for_building: draft.isDefaultForBuilding,
      p_is_active: draft.isActive,
    });

    if (saveError) {
      setError(saveError.message);
    } else {
      const savedId = data as string;
      setSuccess(draft.id ? 'บันทึกจุดถือครองแล้ว' : 'เพิ่มจุดถือครองแล้ว');
      await loadSettings(savedId);
    }
    setSaving(false);
  }

  if (loading) return <p className="empty-text">กำลังโหลดจุดถือครองสต๊อก...</p>;

  return (
    <div className="location-settings">
      <section className="panel stack">
        <div className="panel-header">
          <div>
            <p className="eyebrow">จุดปฏิบัติงาน</p>
            <h2>จุดถือครองสต๊อกทั้งหมด</h2>
          </div>
          <button className="ghost-button" onClick={() => setDraft(EMPTY_DRAFT)} type="button">
            + จุดใหม่
          </button>
        </div>
        <p className="muted">เพิ่ม แก้ไข และพักใช้งานรถบรรทุก จุดปฏิบัติงาน หรือจุดถือครองอื่นได้จากหน้านี้</p>
        <div className="settings-list">
          {locations.map((location) => (
            <button
              className={`round-item ${draft.id === location.id ? 'round-item--selected' : ''}`}
              key={location.id}
              onClick={() => chooseLocation(location)}
              type="button"
            >
              <span>{location.code} · {location.name}</span>
              <small>{KIND_LABELS[location.kind]} · {location.is_active ? 'ใช้งาน' : 'พักใช้งาน'}</small>
            </button>
          ))}
          {locations.length === 0 ? <p className="empty-text">ยังไม่มีจุดถือครอง กรุณาเพิ่มจุดแรก</p> : null}
        </div>
      </section>

      <section className="panel stack">
        <div>
          <p className="eyebrow">{draft.id ? 'แก้ไขจุด' : 'จุดใหม่'}</p>
          <h2>รายละเอียดจุดถือครอง</h2>
        </div>
        <form className="settings-form" onSubmit={saveLocation}>
          <div className="field-grid">
            <label>รหัส<input required value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} /></label>
            <label>ชื่อ<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          </div>
          <div className="field-grid">
            <label>
              ประเภท
              <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as StockLocationKind })}>
                {LOCATION_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
              </select>
            </label>
            <label>
              ตึกที่เกี่ยวข้อง (ถ้ามี)
              <select value={draft.buildingId} onChange={(event) => setDraft({ ...draft, buildingId: event.target.value })}>
                <option value="">ไม่ผูกกับตึก</option>
                {buildings.map((building) => <option key={building.id} value={building.id}>{building.code} · {building.name}</option>)}
              </select>
            </label>
            <label>
              ผู้รับผิดชอบ {draft.kind === 'team' ? '(จำเป็น)' : '(ถ้ามี)'}
              <select
                required={draft.kind === 'team'}
                value={draft.assignedUserId}
                onChange={(event) => setDraft({ ...draft, assignedUserId: event.target.value })}
              >
                <option value="">ไม่ผูกผู้ใช้</option>
                {members.map((member) => <option key={member.id} value={member.id}>{member.code} · {member.display_name}</option>)}
              </select>
            </label>
          </div>
          <label className="inline-check">
            <input checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} type="checkbox" />
            เปิดใช้งานจุดนี้
          </label>
          {draft.kind === 'truck' ? <label className="inline-check">
            <input checked={draft.isCourierSource} onChange={(event) => setDraft({ ...draft, isCourierSource: event.target.checked })} type="checkbox" />
            ใช้เป็นรถหลักสำหรับพนักงานส่ง
          </label> : null}
          {draft.kind === 'work_site' ? <label className="inline-check">
            <input checked={draft.isDefaultForBuilding} onChange={(event) => setDraft({ ...draft, isDefaultForBuilding: event.target.checked })} type="checkbox" />
            ใช้เป็นจุดสต๊อกหลักของตึก
          </label> : null}
          {error ? <p className="error-text">{error}</p> : null}
          {success ? <p className="success-text">{success}</p> : null}
          <button className="primary-button" disabled={saving} type="submit">{saving ? 'กำลังบันทึก...' : 'บันทึกจุดถือครอง'}</button>
        </form>
      </section>
    </div>
  );
}
