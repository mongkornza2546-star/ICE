import { FormEvent, useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import type { BuildingOption, BuildingZoneOption, ShopSetting } from './types/app';

interface ShopDraft {
  id: string;
  code: string;
  name: string;
  building_id: string;
  zone_id: string;
  contact_name: string;
  contact_phone: string;
  normal_rounds_per_day: number;
  access_note: string;
  status: 'active' | 'inactive';
}

const emptyDraft: ShopDraft = {
  id: '',
  code: '',
  name: '',
  building_id: '',
  zone_id: '',
  contact_name: '',
  contact_phone: '',
  normal_rounds_per_day: 1,
  access_note: '',
  status: 'active',
};

export function ShopSettings() {
  const [shops, setShops] = useState<ShopSetting[]>([]);
  const [buildings, setBuildings] = useState<BuildingOption[]>([]);
  const [zones, setZones] = useState<BuildingZoneOption[]>([]);
  const [draft, setDraft] = useState<ShopDraft>(emptyDraft);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings();
  }, []);

  async function loadSettings() {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    const [shopsResponse, buildingsResponse, zonesResponse] = await Promise.all([
      supabase
        .from('shops')
        .select('id, code, name, building_id, zone_id, floor_or_zone, contact_name, contact_phone, normal_rounds_per_day, access_note, status')
        .order('code'),
      supabase.from('buildings').select('id, code, name').eq('is_active', true).order('code'),
      supabase.from('building_zones').select('id, building_id, code, name, sort_order, is_active').eq('is_active', true).order('sort_order'),
    ]);
    const firstError = shopsResponse.error ?? buildingsResponse.error ?? zonesResponse.error;
    if (firstError) {
      setError(firstError.message);
    } else {
      setShops((shopsResponse.data ?? []) as ShopSetting[]);
      setBuildings((buildingsResponse.data ?? []) as BuildingOption[]);
      setZones((zonesResponse.data ?? []) as BuildingZoneOption[]);
    }
    setLoading(false);
  }

  const filteredShops = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('th');
    if (!needle) return shops;
    return shops.filter((shop) =>
      `${shop.code} ${shop.name}`.toLocaleLowerCase('th').includes(needle),
    );
  }, [query, shops]);

  const selectShop = (shop: ShopSetting) => {
    setDraft({
      id: shop.id,
      code: shop.code,
      name: shop.name,
      building_id: shop.building_id,
      zone_id: shop.zone_id,
      contact_name: shop.contact_name ?? '',
      contact_phone: shop.contact_phone ?? '',
      normal_rounds_per_day: shop.normal_rounds_per_day,
      access_note: shop.access_note ?? '',
      status: shop.status,
    });
    setError(null);
    setSuccess(null);
  };

  const startNew = () => {
    setDraft({
      ...emptyDraft,
      building_id: buildings[0]?.id ?? '',
      zone_id: zones.find((zone) => zone.building_id === buildings[0]?.id)?.id ?? '',
    });
    setError(null);
    setSuccess(null);
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    const { data, error: saveError } = await supabase.rpc('save_shop', {
      p_shop_id: draft.id || null,
      p_code: draft.code,
      p_name: draft.name,
      p_zone_id: draft.zone_id,
      p_contact_name: draft.contact_name || null,
      p_contact_phone: draft.contact_phone || null,
      p_normal_rounds_per_day: draft.normal_rounds_per_day,
      p_access_note: draft.access_note || null,
      p_status: draft.status,
    });

    if (saveError) {
      setError(saveError.message);
      setSaving(false);
      return;
    }

    setSuccess(draft.id ? 'บันทึกการแก้ไขร้านแล้ว' : 'เพิ่มร้านใหม่แล้ว');
    await loadSettings();
    setDraft((current) => ({ ...current, id: data as string }));
    setSaving(false);
  };

  if (loading) return <p className="empty-text">กำลังโหลดข้อมูลร้าน...</p>;

  return (
    <div className="settings-grid">
      <section className="panel stack">
        <div className="panel-header">
          <div>
            <p className="eyebrow">ข้อมูลหลัก</p>
            <h2>ร้านค้าทั้งหมด</h2>
          </div>
          <button className="ghost-button" onClick={startNew} type="button">+ ร้านใหม่</button>
        </div>
        <input
          aria-label="ค้นหาร้าน"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ค้นหารหัสหรือชื่อร้าน"
          value={query}
        />
        <div className="settings-list">
          {filteredShops.map((shop) => {
            const building = buildings.find((item) => item.id === shop.building_id);
            const zone = zones.find((item) => item.id === shop.zone_id);
            return (
              <button
                className={`round-item ${draft.id === shop.id ? 'round-item--selected' : ''}`}
                key={shop.id}
                onClick={() => selectShop(shop)}
                type="button"
              >
                <span>{shop.code} · {shop.name}</span>
                <small>{building?.name ?? 'ไม่พบตึก'} · {zone?.name ?? shop.floor_or_zone} · {shop.status === 'active' ? 'ใช้งาน' : 'พักใช้งาน'}</small>
              </button>
            );
          })}
          {filteredShops.length === 0 ? <p className="empty-text">ไม่พบร้าน</p> : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">ตั้งค่าร้านค้า</p>
            <h2>{draft.id ? `แก้ไข ${draft.name}` : 'เพิ่มร้านใหม่'}</h2>
          </div>
        </div>
        <form className="settings-form" onSubmit={handleSave}>
          <div className="field-grid">
            <TextField label="รหัสร้าน" required value={draft.code} onChange={(code) => setDraft({ ...draft, code })} />
            <TextField label="ชื่อร้าน" required value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
            <label>
              อาคาร
              <select required value={draft.building_id} onChange={(event) => {
                const building_id = event.target.value;
                setDraft({ ...draft, building_id, zone_id: zones.find((zone) => zone.building_id === building_id)?.id ?? '' });
              }}>
                <option value="">เลือกตึก</option>
                {buildings.map((building) => <option key={building.id} value={building.id}>{building.code} · {building.name}</option>)}
              </select>
            </label>
            <label>
              โซนย่อย
              <select required value={draft.zone_id} onChange={(event) => setDraft({ ...draft, zone_id: event.target.value })}>
                <option value="">เลือกโซนย่อย</option>
                {zones.filter((zone) => zone.building_id === draft.building_id).map((zone) => <option key={zone.id} value={zone.id}>{zone.code} · {zone.name}</option>)}
              </select>
            </label>
            <TextField label="ผู้ติดต่อ" value={draft.contact_name} onChange={(contact_name) => setDraft({ ...draft, contact_name })} />
            <TextField label="เบอร์โทร" value={draft.contact_phone} onChange={(contact_phone) => setDraft({ ...draft, contact_phone })} />
            <label>
              รอบปกติต่อวัน
              <input min={1} required type="number" value={draft.normal_rounds_per_day} onChange={(event) => setDraft({ ...draft, normal_rounds_per_day: Math.max(1, Number(event.target.value) || 1) })} />
            </label>
            <label>
              สถานะร้าน
              <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as ShopDraft['status'] })}>
                <option value="active">ใช้งาน</option>
                <option value="inactive">พักใช้งาน</option>
              </select>
            </label>
          </div>
          <label>
            หมายเหตุการเข้าถึง
            <textarea rows={3} value={draft.access_note} onChange={(event) => setDraft({ ...draft, access_note: event.target.value })} />
          </label>
          {error ? <p className="error-text">{error}</p> : null}
          {success ? <p className="success-text">{success}</p> : null}
          <button className="primary-button" disabled={saving} type="submit">{saving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่าร้าน'}</button>
          <p className="muted">ร้านที่เปิดใช้งานจะปรากฏในรอบส่งใหม่ทั้งหมด พนักงานเลือกเองว่าจะไปร้านใด</p>
        </form>
      </section>
    </div>
  );
}

function TextField({ label, value, required, onChange }: { label: string; value: string; required?: boolean; onChange: (value: string) => void }) {
  return (
    <label>
      {label}
      <input required={required} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
