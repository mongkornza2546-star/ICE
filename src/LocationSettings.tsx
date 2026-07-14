import { FormEvent, useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import type { BuildingOption, BuildingZoneOption } from './types/app';

export function LocationSettings() {
  const [buildings, setBuildings] = useState<BuildingOption[]>([]);
  const [zones, setZones] = useState<BuildingZoneOption[]>([]);
  const [selectedBuildingId, setSelectedBuildingId] = useState('');
  const [buildingDraft, setBuildingDraft] = useState({ id: '', code: '', name: '', is_active: true });
  const [zoneDraft, setZoneDraft] = useState({ id: '', code: '', name: '', sort_order: 1, is_active: true });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'building' | 'zone' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    void loadLocations();
  }, []);

  async function loadLocations(preferredBuildingId?: string) {
    if (!supabase) return;
    setLoading(true);
    const [buildingResponse, zoneResponse] = await Promise.all([
      supabase.from('buildings').select('id, code, name, is_active').order('code'),
      supabase.from('building_zones').select('id, building_id, code, name, sort_order, is_active').order('sort_order'),
    ]);
    const firstError = buildingResponse.error ?? zoneResponse.error;
    if (firstError) {
      setError(firstError.message);
    } else {
      const nextBuildings = (buildingResponse.data ?? []) as BuildingOption[];
      setBuildings(nextBuildings);
      setZones((zoneResponse.data ?? []) as BuildingZoneOption[]);
      setSelectedBuildingId((current) => preferredBuildingId || current || nextBuildings[0]?.id || '');
    }
    setLoading(false);
  }

  const selectedBuilding = buildings.find((item) => item.id === selectedBuildingId) ?? null;
  const buildingZones = useMemo(
    () => zones.filter((zone) => zone.building_id === selectedBuildingId),
    [zones, selectedBuildingId],
  );
  const nextZoneSortOrder = Math.max(0, ...buildingZones.map((zone) => zone.sort_order)) + 1;

  const chooseBuilding = (building: BuildingOption) => {
    setSelectedBuildingId(building.id);
    setBuildingDraft({ id: building.id, code: building.code, name: building.name, is_active: building.is_active ?? true });
    const nextSortOrder = Math.max(0, ...zones.filter((zone) => zone.building_id === building.id).map((zone) => zone.sort_order)) + 1;
    setZoneDraft({ id: '', code: '', name: '', sort_order: nextSortOrder, is_active: true });
    setError(null);
    setSuccess(null);
  };

  const saveBuilding = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) return;
    setSaving('building');
    setError(null);
    setSuccess(null);
    const payload = {
      code: buildingDraft.code.trim(),
      name: buildingDraft.name.trim(),
      is_active: buildingDraft.is_active,
    };
    const response = buildingDraft.id
      ? await supabase.from('buildings').update(payload).eq('id', buildingDraft.id).select('id').single()
      : await supabase.from('buildings').insert(payload).select('id').single();
    if (response.error) {
      setError(response.error.message);
    } else {
      setSuccess(buildingDraft.id ? 'บันทึกข้อมูลตึกแล้ว' : 'เพิ่มตึกแล้ว กรุณาเพิ่มโซนย่อยต่อ');
      setBuildingDraft((current) => ({ ...current, id: response.data.id }));
      setSelectedBuildingId(response.data.id);
      await loadLocations(response.data.id);
    }
    setSaving(null);
  };

  const saveZone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !selectedBuildingId) return;
    setSaving('zone');
    setError(null);
    setSuccess(null);
    const payload = {
      building_id: selectedBuildingId,
      code: zoneDraft.code.trim(),
      name: zoneDraft.name.trim(),
      sort_order: zoneDraft.sort_order,
      is_active: zoneDraft.is_active,
    };
    const response = zoneDraft.id
      ? await supabase.from('building_zones').update(payload).eq('id', zoneDraft.id)
      : await supabase.from('building_zones').insert(payload);
    if (response.error) {
      setError(response.error.message);
    } else {
      setSuccess(zoneDraft.id ? 'บันทึกโซนย่อยแล้ว' : 'เพิ่มโซนย่อยแล้ว');
      setZoneDraft({ id: '', code: '', name: '', sort_order: nextZoneSortOrder + 1, is_active: true });
      await loadLocations(selectedBuildingId);
    }
    setSaving(null);
  };

  if (loading) return <p className="empty-text">กำลังโหลดตึกและโซนย่อย...</p>;

  return (
    <div className="location-settings">
      <section className="panel stack">
        <div className="panel-header">
          <div><p className="eyebrow">ขั้นที่ 1</p><h2>ตั้งค่าตึก</h2></div>
          <button className="ghost-button" onClick={() => setBuildingDraft({ id: '', code: '', name: '', is_active: true })} type="button">+ ตึกใหม่</button>
        </div>
        <div className="settings-list">
          {buildings.map((building) => (
            <button className={`round-item ${selectedBuildingId === building.id ? 'round-item--selected' : ''}`} key={building.id} onClick={() => chooseBuilding(building)} type="button">
              <span>{building.code} · {building.name}</span>
              <small>{building.is_active ? 'ใช้งาน' : 'พักใช้งาน'} · {zones.filter((zone) => zone.building_id === building.id).length} โซนย่อย</small>
            </button>
          ))}
        </div>
        <form className="settings-form" onSubmit={saveBuilding}>
          <div className="field-grid">
            <TextField label="รหัสตึก" required value={buildingDraft.code} onChange={(code) => setBuildingDraft({ ...buildingDraft, code })} />
            <TextField label="ชื่อตึก" required value={buildingDraft.name} onChange={(name) => setBuildingDraft({ ...buildingDraft, name })} />
          </div>
          <label className="inline-check"><input checked={buildingDraft.is_active} onChange={(event) => setBuildingDraft({ ...buildingDraft, is_active: event.target.checked })} type="checkbox" /> เปิดใช้งานตึก</label>
          <button className="primary-button" disabled={saving === 'building'} type="submit">{saving === 'building' ? 'กำลังบันทึก...' : 'บันทึกตึก'}</button>
        </form>
      </section>

      <section className="panel stack">
        <div className="panel-header">
          <div><p className="eyebrow">ขั้นที่ 2</p><h2>โซนย่อย {selectedBuilding ? `· ${selectedBuilding.name}` : ''}</h2></div>
          <button className="ghost-button" disabled={!selectedBuildingId} onClick={() => setZoneDraft({ id: '', code: '', name: '', sort_order: nextZoneSortOrder, is_active: true })} type="button">+ โซนใหม่</button>
        </div>
        {!selectedBuildingId ? <p className="empty-text">เลือกหรือสร้างตึกก่อน</p> : (
          <>
            <div className="zone-grid">
              {buildingZones.map((zone) => (
                <button className={`choice-chip ${zoneDraft.id === zone.id ? 'choice-chip--selected' : ''}`} key={zone.id} onClick={() => setZoneDraft({ id: zone.id, code: zone.code, name: zone.name, sort_order: zone.sort_order, is_active: zone.is_active })} type="button">
                  <span>{zone.sort_order}. {zone.code} · {zone.name}</span>
                  <small>{zone.is_active ? 'ใช้งาน' : 'พักใช้งาน'}</small>
                </button>
              ))}
            </div>
            <form className="settings-form" onSubmit={saveZone}>
              <div className="field-grid field-grid--three">
                <TextField label="รหัสโซน" required value={zoneDraft.code} onChange={(code) => setZoneDraft({ ...zoneDraft, code })} />
                <TextField label="ชื่อโซนย่อย" required value={zoneDraft.name} onChange={(name) => setZoneDraft({ ...zoneDraft, name })} />
                <label>ลำดับ<input min={1} required type="number" value={zoneDraft.sort_order} onChange={(event) => setZoneDraft({ ...zoneDraft, sort_order: Math.max(1, Number(event.target.value) || 1) })} /></label>
              </div>
              <label className="inline-check"><input checked={zoneDraft.is_active} onChange={(event) => setZoneDraft({ ...zoneDraft, is_active: event.target.checked })} type="checkbox" /> เปิดใช้งานโซน</label>
              <button className="primary-button" disabled={saving === 'zone'} type="submit">{saving === 'zone' ? 'กำลังบันทึก...' : 'บันทึกโซนย่อย'}</button>
            </form>
          </>
        )}
        {error ? <p className="error-text">{error}</p> : null}
        {success ? <p className="success-text">{success}</p> : null}
      </section>
    </div>
  );
}

function TextField({ label, value, required, onChange }: { label: string; value: string; required?: boolean; onChange: (value: string) => void }) {
  return <label>{label}<input required={required} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}
