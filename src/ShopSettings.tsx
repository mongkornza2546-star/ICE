import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import { parseShopImportFile, type ShopImportRow } from './lib/shopImport';
import type { BuildingOption, BuildingZoneOption, ShopSetting } from './types/app';
import { ShopImageEditor } from './features/admin-reference-settings/components/ShopImageEditor';

const TANK_IMAGE_BUCKET = 'tank-images';
const MAX_TANK_IMAGE_SIZE = 5 * 1024 * 1024;
const TANK_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

interface ShopDraft {
  id: string;
  code: string;
  name: string;
  building_id: string;
  zone_id: string;
  government_shop_code: string;
  contact_name: string;
  contact_phone: string;
  normal_rounds_per_day: number;
  access_note: string;
  status: 'active' | 'inactive';
}

interface ShopRentedTank {
  id: string;
  shop_id: string;
  tank_code: string;
  image_path: string;
  rented_at: string;
  image_url: string | null;
}

const emptyDraft: ShopDraft = {
  id: '',
  code: '',
  name: '',
  building_id: '',
  zone_id: '',
  government_shop_code: '',
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
  const [importRows, setImportRows] = useState<ShopImportRow[]>([]);
  const [importFileName, setImportFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [rentedTanks, setRentedTanks] = useState<ShopRentedTank[]>([]);
  const [tankCode, setTankCode] = useState('');
  const [tankImageFile, setTankImageFile] = useState<File | null>(null);
  const [savingTank, setSavingTank] = useState(false);
  const [tankError, setTankError] = useState<string | null>(null);
  const [tankSuccess, setTankSuccess] = useState<string | null>(null);

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
        .select('id, code, name, image_path, building_id, zone_id, floor_or_zone, government_shop_code, contact_name, contact_phone, normal_rounds_per_day, access_note, status')
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
      await refreshRentedTanks();
    }
    setLoading(false);
  }

  async function refreshRentedTanks() {
    const client = supabase;
    if (!client) return;

    const { data, error: loadError } = await client
      .from('shop_rented_tanks')
      .select('id, shop_id, tank_code, image_path, rented_at')
      .is('returned_at', null)
      .order('tank_code');

    if (loadError) {
      setError(loadError.message);
      return;
    }

    const tanksWithUrls = await Promise.all(((data ?? []) as Omit<ShopRentedTank, 'image_url'>[]).map(async (tank) => {
      const { data: imageData, error: imageError } = await client.storage
        .from(TANK_IMAGE_BUCKET)
        .createSignedUrl(tank.image_path, 3600);
      return { ...tank, image_url: imageError ? null : imageData.signedUrl };
    }));
    setRentedTanks(tanksWithUrls);
  }

  const filteredShops = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('th');
    if (!needle) return shops;
    return shops.filter((shop) =>
      `${shop.code} ${shop.government_shop_code ?? ''} ${shop.name}`.toLocaleLowerCase('th').includes(needle),
    );
  }, [query, shops]);

  const selectShop = (shop: ShopSetting) => {
    setDraft({
      id: shop.id,
      code: shop.code,
      name: shop.name,
      building_id: shop.building_id,
      zone_id: shop.zone_id,
      government_shop_code: shop.government_shop_code ?? '',
      contact_name: shop.contact_name ?? '',
      contact_phone: shop.contact_phone ?? '',
      normal_rounds_per_day: shop.normal_rounds_per_day,
      access_note: shop.access_note ?? '',
      status: shop.status,
    });
    setError(null);
    setSuccess(null);
    resetTankDraft();
  };

  const startNew = () => {
    setDraft({
      ...emptyDraft,
      building_id: buildings[0]?.id ?? '',
      zone_id: zones.find((zone) => zone.building_id === buildings[0]?.id)?.id ?? '',
    });
    setError(null);
    setSuccess(null);
    resetTankDraft();
  };

  const activeShopTanks = useMemo(
    () => rentedTanks.filter((tank) => tank.shop_id === draft.id),
    [draft.id, rentedTanks],
  );

  function resetTankDraft() {
    setTankCode('');
    setTankImageFile(null);
    setTankError(null);
    setTankSuccess(null);
  }

  function chooseTankImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (file.size > MAX_TANK_IMAGE_SIZE) {
      setTankImageFile(null);
      setTankError('รูปถังต้องมีขนาดไม่เกิน 5 MB');
      return;
    }

    if (!TANK_IMAGE_EXTENSIONS[file.type]) {
      setTankImageFile(null);
      setTankError('รองรับรูปถังเฉพาะไฟล์ JPG, PNG หรือ WEBP');
      return;
    }

    setTankImageFile(file);
    setTankError(null);
    setTankSuccess(null);
  }

  async function registerRentedTank() {
    if (!supabase || !draft.id) return;
    const normalizedCode = tankCode.trim().toLocaleUpperCase('en-US');
    if (!normalizedCode || !tankImageFile) {
      setTankError('กรุณาระบุรหัสถังและเลือกรูปถังให้ครบ');
      return;
    }

    setSavingTank(true);
    setTankError(null);
    setTankSuccess(null);
    const extension = TANK_IMAGE_EXTENSIONS[tankImageFile.type];
    const imagePath = `${draft.id}/${crypto.randomUUID()}.${extension}`;

    try {
      const { error: uploadError } = await supabase.storage
        .from(TANK_IMAGE_BUCKET)
        .upload(imagePath, tankImageFile, {
          cacheControl: '3600',
          contentType: tankImageFile.type,
          upsert: false,
        });
      if (uploadError) {
        setTankError(uploadError.message);
        return;
      }

      const { error: registerError } = await supabase.rpc('register_shop_rented_tank', {
        p_shop_id: draft.id,
        p_tank_code: normalizedCode,
        p_image_path: imagePath,
      });
      if (registerError) {
        await supabase.storage.from(TANK_IMAGE_BUCKET).remove([imagePath]);
        setTankError(registerError.message);
        return;
      }

      setTankCode('');
      setTankImageFile(null);
      setTankSuccess(`เพิ่มถัง ${normalizedCode} แล้ว`);
      await refreshRentedTanks();
    } catch (registerError) {
      setTankError(registerError instanceof Error ? registerError.message : 'เพิ่มข้อมูลถังไม่สำเร็จ');
    } finally {
      setSavingTank(false);
    }
  }

  async function returnRentedTank(tank: ShopRentedTank) {
    if (!supabase || !window.confirm(`ยืนยันว่าร้านคืนถัง ${tank.tank_code} แล้ว`)) return;
    setSavingTank(true);
    setTankError(null);
    setTankSuccess(null);
    const { error: returnError } = await supabase.rpc('return_shop_rented_tank', { p_tank_id: tank.id });
    if (returnError) {
      setTankError(returnError.message);
    } else {
      setTankSuccess(`บันทึกรับคืนถัง ${tank.tank_code} แล้ว`);
      await refreshRentedTanks();
    }
    setSavingTank(false);
  }

  const chooseImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportRows([]);
    setImportFileName(file.name);
    setImportError(null);
    setImportSuccess(null);
    try {
      setImportRows(await parseShopImportFile(file));
    } catch (parseError) {
      setImportError(parseError instanceof Error ? parseError.message : 'อ่านไฟล์ Excel ไม่สำเร็จ');
    }
  };

  const importCatalog = async () => {
    if (!supabase || importRows.length === 0) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    const { data, error: rpcError } = await supabase.rpc('import_shop_catalog', { p_rows: importRows });
    if (rpcError) {
      setImportError(rpcError.message);
    } else {
      const result = data as { created_shop_count: number; updated_shop_count: number };
      setImportSuccess(`นำเข้าสำเร็จ: เพิ่ม ${result.created_shop_count} ร้าน · อัปเดต ${result.updated_shop_count} ร้าน`);
      setImportRows([]);
      setImportFileName('');
      await loadSettings();
    }
    setImporting(false);
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
      p_government_shop_code: draft.government_shop_code || null,
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
      <section className="panel shop-import-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">นำเข้าหลายร้าน</p>
            <h2>อัปโหลด Excel</h2>
          </div>
          <a className="ghost-button" download href="/templates/shop-import-template.xlsx">ดาวน์โหลดไฟล์แม่แบบ</a>
        </div>
        <p className="muted">หนึ่งแถวต่อหนึ่งร้าน ระบบใช้รหัสตัวพิมพ์ใหญ่ และจะไม่เปลี่ยนลำดับหรือเปิดใช้ตึก/โซนเดิมโดยอัตโนมัติ</p>
        <div className="shop-import-actions">
          <label className="secondary-button shop-import-file">
            เลือกไฟล์ .xlsx
            <input accept=".xlsx" onChange={chooseImportFile} type="file" />
          </label>
          {importFileName ? <span>{importFileName} · {importRows.length} ร้าน</span> : null}
          <button className="primary-button" disabled={importing || importRows.length === 0} onClick={importCatalog} type="button">
            {importing ? 'กำลังนำเข้า...' : `ยืนยันนำเข้า ${importRows.length || ''} ร้าน`}
          </button>
        </div>
        {importRows.length > 0 ? (
          <div className="data-table-wrap shop-import-preview">
            <table className="data-table">
              <thead><tr><th>รหัสร้าน</th><th>ชื่อร้าน</th><th>ตึก</th><th>โซนย่อย</th><th>สถานะ</th></tr></thead>
              <tbody>{importRows.slice(0, 8).map((row) => (
                <tr key={row.shop_code}><td>{row.shop_code}</td><td>{row.shop_name}</td><td>{row.building_code} · {row.building_name}</td><td>{row.zone_code} · {row.zone_name}</td><td>{row.status === 'active' ? 'ใช้งาน' : 'พักใช้งาน'}</td></tr>
              ))}</tbody>
            </table>
            {importRows.length > 8 ? <p className="muted shop-import-more">และอีก {importRows.length - 8} ร้าน</p> : null}
          </div>
        ) : null}
        {importError ? <p className="error-text shop-import-message">{importError}</p> : null}
        {importSuccess ? <p className="success-text shop-import-message">{importSuccess}</p> : null}
      </section>
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
          placeholder="ค้นหารหัส ชื่อร้าน หรือรหัสศูนย์ราชการ"
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
            <TextField label="รหัสศูนย์ราชการ" value={draft.government_shop_code} onChange={(government_shop_code) => setDraft({ ...draft, government_shop_code })} />
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

        <div className="rented-tank-section">
          <div className="panel-header">
            <div>
              <p className="eyebrow">ทะเบียนถังประจำร้าน</p>
              <h3>ถังเช่า {activeShopTanks.length} ใบ</h3>
            </div>
          </div>
          {!draft.id ? (
            <p className="muted">บันทึกข้อมูลร้านก่อน แล้วจึงเพิ่มรหัสและรูปถังเช่าแต่ละใบ</p>
          ) : (
            <>
              <div className="rented-tank-list">
                {activeShopTanks.map((tank) => (
                  <article className="rented-tank-card" key={tank.id}>
                    {tank.image_url ? (
                      <img alt={`ถัง ${tank.tank_code}`} className="rented-tank-photo" src={tank.image_url} />
                    ) : (
                      <div className="rented-tank-photo rented-tank-photo--placeholder">ไม่มีรูปตัวอย่าง</div>
                    )}
                    <div>
                      <strong>{tank.tank_code}</strong>
                      <small>เริ่มเช่า {new Date(tank.rented_at).toLocaleDateString('th-TH')}</small>
                    </div>
                    <button className="ghost-button" disabled={savingTank} onClick={() => void returnRentedTank(tank)} type="button">
                      รับคืนถัง
                    </button>
                  </article>
                ))}
                {activeShopTanks.length === 0 ? <p className="empty-text">ร้านนี้ยังไม่มีถังเช่า</p> : null}
              </div>
              <div className="rented-tank-entry">
                <TextField label="รหัสถัง" required value={tankCode} onChange={setTankCode} />
                <label className="secondary-button rented-tank-file">
                  เลือกรูปถัง
                  <input accept="image/jpeg,image/png,image/webp" onChange={chooseTankImage} type="file" />
                </label>
                <span className="muted">{tankImageFile?.name ?? 'ยังไม่ได้เลือกรูป'}</span>
                <button className="primary-button" disabled={savingTank} onClick={() => void registerRentedTank()} type="button">
                  {savingTank ? 'กำลังบันทึก...' : 'เพิ่มถังเช่า'}
                </button>
              </div>
            </>
          )}
          {tankError ? <p className="error-text">{tankError}</p> : null}
          {tankSuccess ? <p className="success-text">{tankSuccess}</p> : null}
          <p className="muted">จำนวนถังเช่าคำนวณจากรายการรหัสถังที่ยังไม่ได้รับคืน จึงไม่ต้องกรอกจำนวนแยก</p>
        </div>
      </section>

      <div className="shop-image-editor">
        <ShopImageEditor
          onShopSaved={(savedShop) => setShops((current) => current.map((shop) => shop.id === savedShop.id ? { ...shop, image_path: savedShop.image_path } : shop))}
          shops={shops}
        />
      </div>
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
