import { translateUi, useLanguage } from './i18n';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import { isEventLocationCode } from './lib/eventLocationCode';
import type { BuildingOption, BuildingZoneOption } from './types/app';

const emptyDraft = (sort_order = 1) => ({ id: '', code: '', name: '', sort_order, is_active: true });

export function LocationSettings() {
  useLanguage();
  const [buildings, setBuildings] = useState<BuildingOption[]>([]);
  const [zones, setZones] = useState<BuildingZoneOption[]>([]);
  const [selectedBuildingId, setSelectedBuildingId] = useState('');
  const [buildingDraft, setBuildingDraft] = useState(emptyDraft);
  const [zoneDraft, setZoneDraft] = useState(emptyDraft);
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
      supabase.from('buildings').select('id, code, name, sort_order, is_active').order('sort_order').order('code'),
      supabase.from('building_zones').select('id, building_id, code, name, sort_order, is_active').order('sort_order'),
    ]);
    const firstError = buildingResponse.error ?? zoneResponse.error;
    if (firstError) {
      setError(firstError.message);
    } else {
      const nextBuildings = (buildingResponse.data ?? []) as BuildingOption[];
      const nextZones = (zoneResponse.data ?? []) as BuildingZoneOption[];
      const permanentBuildings = nextBuildings.filter((building) => !isEventLocationCode(building.code));
      const permanentBuildingIds = new Set(permanentBuildings.map((building) => building.id));
      const requestedId = preferredBuildingId || selectedBuildingId;
      const nextSelectedId = permanentBuildingIds.has(requestedId) ? requestedId : permanentBuildings[0]?.id || '';
      const nextZoneOrder = Math.max(0, ...nextZones.filter((zone) => zone.building_id === nextSelectedId).map((zone) => zone.sort_order)) + 1;
      setBuildings(nextBuildings);
      setZones(nextZones);
      setSelectedBuildingId(nextSelectedId);
      setBuildingDraft((current) => current.id && !permanentBuildingIds.has(current.id)
        ? emptyDraft(Math.max(0, ...nextBuildings.map((building) => building.sort_order ?? 0)) + 1)
        : current);
      setZoneDraft((current) => current.id && nextZones.some((zone) => zone.id === current.id
        && zone.building_id === nextSelectedId && !isEventLocationCode(zone.code))
        ? current : emptyDraft(nextZoneOrder));
    }
    setLoading(false);
  }

  const permanentBuildings = useMemo(() => buildings.filter((building) => !isEventLocationCode(building.code)), [buildings]);
  const selectedBuilding = permanentBuildings.find((item) => item.id === selectedBuildingId) ?? null;
  const buildingZones = useMemo(
    () => zones.filter((zone) => zone.building_id === selectedBuildingId && !isEventLocationCode(zone.code)),
    [zones, selectedBuildingId],
  );
  // Hidden compatibility zones still occupy their sort orders in the database.
  const nextZoneSortOrder = Math.max(0, ...zones.filter((zone) => zone.building_id === selectedBuildingId).map((zone) => zone.sort_order)) + 1;
  const nextBuildingSortOrder = Math.max(0, ...buildings.map((building) => building.sort_order ?? 0)) + 1;

  const chooseBuilding = (building: BuildingOption) => {
    setSelectedBuildingId(building.id);
    setBuildingDraft({ id: building.id, code: building.code, name: building.name, sort_order: building.sort_order ?? 1, is_active: building.is_active ?? true });
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
    const response = await supabase.rpc('save_building_settings', {
      p_building_id: buildingDraft.id || null,
      p_code: buildingDraft.code.trim(),
      p_name: buildingDraft.name.trim(),
      p_sort_order: buildingDraft.sort_order,
      p_is_active: buildingDraft.is_active,
    });
    if (response.error) {
      setError(response.error.message);
    } else {
      setSuccess(buildingDraft.id ? 'บันทึกข้อมูลตึกแล้ว' : 'เพิ่มตึกแล้ว กรุณาเพิ่มโซนย่อยต่อ');
      const buildingId = response.data as string;
      setBuildingDraft((current) => ({ ...current, id: buildingId }));
      setSelectedBuildingId(buildingId);
      await loadLocations(buildingId);
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

  if (loading) return <p className="empty-text">{translateUi('กำลังโหลดตึกและโซนย่อย...')}</p>;

  return (
    <div className="location-settings">
      <section className="panel stack">
        <div className="panel-header">
          <div><p className="eyebrow">{translateUi('ขั้นที่ 1')}</p><h2>{translateUi('ตั้งค่าตึก')}</h2></div>
          <button className="ghost-button" onClick={() => setBuildingDraft({ id: '', code: '', name: '', sort_order: nextBuildingSortOrder, is_active: true })} type="button">{translateUi('+ ตึกใหม่')}</button>
        </div>
        <p className="muted">{translateUi('จัดการตึกและโซนถาวรที่นี่ · จัดการงานชั่วคราวในเมนูงานอีเวนต์')}</p>
        <div className="settings-list">
          {permanentBuildings.map((building) => (
            <button className={`round-item ${selectedBuildingId === building.id ? 'round-item--selected' : ''}`} key={building.id} onClick={() => chooseBuilding(building)} type="button">
              <span>{building.sort_order ?? '—'}. {building.code} · {building.name}</span>
              <small>{building.is_active ? translateUi('ใช้งาน') : translateUi('พักใช้งาน')} · {zones.filter((zone) => zone.building_id === building.id && !isEventLocationCode(zone.code)).length}{translateUi(' โซนย่อย')}</small>
            </button>
          ))}
          {permanentBuildings.length === 0 ? <p className="empty-text">{translateUi('ยังไม่มีตึกถาวร กรุณาเพิ่มตึก')}</p> : null}
        </div>
        <form className="settings-form" onSubmit={saveBuilding}>
          <div className="field-grid field-grid--three">
            <TextField label={translateUi('รหัสตึก')} required value={buildingDraft.code} onChange={(code) => setBuildingDraft({ ...buildingDraft, code })} />
            <TextField label={translateUi('ชื่อตึก')} required value={buildingDraft.name} onChange={(name) => setBuildingDraft({ ...buildingDraft, name })} />
            <label>{translateUi('ลำดับ')}<input min={1} required step={1} type="number" value={buildingDraft.sort_order} onChange={(event) => setBuildingDraft({ ...buildingDraft, sort_order: Math.max(1, Math.floor(Number(event.target.value) || 1)) })} /></label>
          </div>
          <label className="inline-check"><input checked={buildingDraft.is_active} onChange={(event) => setBuildingDraft({ ...buildingDraft, is_active: event.target.checked })} type="checkbox" />{translateUi(' เปิดใช้งานตึก')}</label>
          <button className="primary-button" disabled={saving === 'building'} type="submit">{saving === 'building' ? translateUi('กำลังบันทึก...') : translateUi('บันทึกตึก')}</button>
        </form>
      </section>

      <section className="panel stack">
        <div className="panel-header">
          <div><p className="eyebrow">{translateUi('ขั้นที่ 2')}</p><h2>{translateUi('โซนย่อย ')}{selectedBuilding ? `· ${selectedBuilding.name}` : ''}</h2></div>
          <button className="ghost-button" disabled={!selectedBuildingId} onClick={() => setZoneDraft({ id: '', code: '', name: '', sort_order: nextZoneSortOrder, is_active: true })} type="button">{translateUi('+ โซนใหม่')}</button>
        </div>
        {!selectedBuildingId ? <p className="empty-text">{translateUi('เลือกหรือสร้างตึกก่อน')}</p> : (
          <>
            <div className="zone-grid">
              {buildingZones.map((zone) => (
                <button className={`choice-chip ${zoneDraft.id === zone.id ? 'choice-chip--selected' : ''}`} key={zone.id} onClick={() => setZoneDraft({ id: zone.id, code: zone.code, name: zone.name, sort_order: zone.sort_order, is_active: zone.is_active })} type="button">
                  <span>{zone.sort_order}. {zone.code} · {zone.name}</span>
                  <small>{zone.is_active ? translateUi('ใช้งาน') : translateUi('พักใช้งาน')}</small>
                </button>
              ))}
            </div>
            <form className="settings-form" onSubmit={saveZone}>
              <div className="field-grid field-grid--three">
                <TextField label={translateUi('รหัสโซน')} required value={zoneDraft.code} onChange={(code) => setZoneDraft({ ...zoneDraft, code })} />
                <TextField label={translateUi('ชื่อโซนย่อย')} required value={zoneDraft.name} onChange={(name) => setZoneDraft({ ...zoneDraft, name })} />
                <label>{translateUi('ลำดับ')}<input min={1} required type="number" value={zoneDraft.sort_order} onChange={(event) => setZoneDraft({ ...zoneDraft, sort_order: Math.max(1, Number(event.target.value) || 1) })} /></label>
              </div>
              <label className="inline-check"><input checked={zoneDraft.is_active} onChange={(event) => setZoneDraft({ ...zoneDraft, is_active: event.target.checked })} type="checkbox" />{translateUi(' เปิดใช้งานโซน')}</label>
              <button className="primary-button" disabled={saving === 'zone'} type="submit">{saving === 'zone' ? translateUi('กำลังบันทึก...') : translateUi('บันทึกโซนย่อย')}</button>
            </form>
          </>
        )}
        {error ? <p className="error-text">{translateUi(error)}</p> : null}
        {success ? <p className="success-text">{translateUi(success)}</p> : null}
      </section>
    </div>
  );
}

function TextField({ label, value, required, onChange }: { label: string; value: string; required?: boolean; onChange: (value: string) => void }) {
  useLanguage();
  return <label>{label}<input required={required} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}
