import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { Buildings, CaretRight, ImageSquare, MagnifyingGlass, MapPin, Phone, Plus, Storefront, X, SlidersHorizontal } from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import { parseShopImportFile, type ShopImportRow } from './lib/shopImport';
import type { BuildingOption, BuildingZoneOption, ShopSetting, IceTypeOption } from './types/app';
import { ShopImageEditor } from './features/admin-reference-settings/components/ShopImageEditor';
import { ShopPaymentProfileEditor } from './features/shop-settings/components/ShopPaymentProfileEditor';
import { ShopSpecialPriceEditor } from './features/shop-settings/components/ShopSpecialPriceEditor';
import { BulkPaymentSetupModal } from './features/shop-settings/components/BulkPaymentSetupModal';
import { ShopReadinessPanel } from './features/shop-settings/components/ShopReadinessPanel';
import { getShopImageSignedUrls } from './features/admin-reference-settings/adminReferenceSettingsService';
import { matchesActiveFilter, type ActiveFilter } from './features/admin-reference-settings/referenceEditorFilters';


const TANK_IMAGE_BUCKET = 'tank-images';
const MAX_TANK_IMAGE_SIZE = 5 * 1024 * 1024;
const SHOP_IMAGE_URL_REFRESH_MS = 55 * 60 * 1000;
const SHOP_IMAGE_URL_RETRY_MS = 60 * 1000;
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
  const [iceTypes, setIceTypes] = useState<IceTypeOption[]>([]);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [draft, setDraft] = useState<ShopDraft>(emptyDraft);
  const [query, setQuery] = useState('');
  const [buildingFilter, setBuildingFilter] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [shopFilter] = useState<ActiveFilter>('all');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 12;
  const [editorOpen, setEditorOpen] = useState(false);
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
  const [shopImageUrls, setShopImageUrls] = useState<Record<string, string>>({});
  const [failedShopImages, setFailedShopImages] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void loadSettings();
  }, []);

  useEffect(() => {
    if (!editorOpen) return;

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving && !savingTank) setEditorOpen(false);
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [editorOpen, saving, savingTank]);

  useEffect(() => {
    let cancelled = false;
    const shopsWithImages = shops.filter((shop) => shop.image_path);
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    if (shopsWithImages.length === 0) {
      setShopImageUrls({});
      setFailedShopImages({});
      return () => { cancelled = true; };
    }

    const refreshImageUrls = async () => {
      let nextRefreshMs = SHOP_IMAGE_URL_REFRESH_MS;
      try {
        const urlsByPath = await getShopImageSignedUrls(shopsWithImages.map((shop) => shop.image_path!));
        if (!cancelled) {
          setShopImageUrls(Object.fromEntries(
            shopsWithImages.flatMap((shop) => {
              const url = urlsByPath[shop.image_path!];
              return url ? [[shop.id, url]] : [];
            }),
          ));
          setFailedShopImages({});
        }
      } catch {
        nextRefreshMs = SHOP_IMAGE_URL_RETRY_MS;
      } finally {
        if (!cancelled) refreshTimer = setTimeout(() => void refreshImageUrls(), nextRefreshMs);
      }
    };

    void refreshImageUrls();

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [shops]);

  async function loadSettings() {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    const [shopsResponse, buildingsResponse, zonesResponse, iceTypesResponse] = await Promise.all([
      supabase
        .from('shops')
        .select('id, code, name, image_path, building_id, zone_id, floor_or_zone, government_shop_code, contact_name, contact_phone, normal_rounds_per_day, access_note, status')
        .order('code'),
      supabase.from('buildings').select('id, code, name').eq('is_active', true).order('code'),
      supabase.from('building_zones').select('id, building_id, code, name, sort_order, is_active').eq('is_active', true).order('sort_order'),
      supabase.from('ice_types').select('id, code, name, unit').eq('is_active', true).order('code'),
    ]);
    const firstError = shopsResponse.error ?? buildingsResponse.error ?? zonesResponse.error ?? iceTypesResponse.error;
    if (firstError) {
      setError(firstError.message);
    } else {
      setShops((shopsResponse.data ?? []) as ShopSetting[]);
      setBuildings((buildingsResponse.data ?? []) as BuildingOption[]);
      setZones((zonesResponse.data ?? []) as BuildingZoneOption[]);
      setIceTypes((iceTypesResponse.data ?? []) as IceTypeOption[]);
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
    return shops.filter((shop) => {
      const matchesSearch = !needle || `${shop.code} ${shop.government_shop_code ?? ''} ${shop.name}`.toLocaleLowerCase('th').includes(needle);
      const matchesBuilding = !buildingFilter || shop.building_id === buildingFilter;
      const matchesZone = !zoneFilter || shop.zone_id === zoneFilter;
      return matchesSearch && matchesActiveFilter(shop.status === 'active', shopFilter) && matchesBuilding && matchesZone;
    });
  }, [query, shopFilter, buildingFilter, zoneFilter, shops]);

  // Reset to page 0 whenever filters change
  useEffect(() => { setPage(0); }, [query, shopFilter, buildingFilter, zoneFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredShops.length / PAGE_SIZE));
  const pagedShops = filteredShops.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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
    setEditorOpen(true);
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
    setEditorOpen(true);
  };

  const closeEditor = () => {
    if (saving || savingTank) return;
    setEditorOpen(false);
  };

  const activeShopTanks = useMemo(
    () => rentedTanks.filter((tank) => tank.shop_id === draft.id),
    [draft.id, rentedTanks],
  );
  const selectedShop = useMemo(
    () => shops.find((shop) => shop.id === draft.id) ?? null,
    [draft.id, shops],
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

  async function deactivateShop() {
    if (!supabase || !draft.id) return;
    if (activeShopTanks.length > 0) {
      setError(`ยังปิดร้านไม่ได้: กรุณารับคืนถังเช่า ${activeShopTanks.length} ใบให้ครบก่อน`);
      return;
    }
    if (!window.confirm(`ยืนยันปิดร้าน ${draft.name || draft.code}?\n\nร้านจะไม่ปรากฏในงานส่งใหม่ แต่ประวัติการส่งจะยังคงอยู่`)) return;

    setSaving(true);
    setError(null);
    setSuccess(null);
    const { error: deactivateError } = await supabase.rpc('deactivate_shop', { p_shop_id: draft.id });
    if (deactivateError) {
      setError(deactivateError.message);
    } else {
      setDraft((current) => ({ ...current, status: 'inactive' }));
      setSuccess('ปิดร้านแล้ว ร้านจะไม่ปรากฏในงานส่งใหม่');
      await loadSettings();
    }
    setSaving(false);
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
      <section className="shop-catalog">
        <div className="shop-catalog__header">
          <div>
            <p className="eyebrow">ข้อมูลหลัก</p>
            <h2>ร้านค้าทั้งหมด</h2>
            <p className="muted">เลือกการ์ดเพื่อดูรายละเอียดและแก้ไขข้อมูลร้าน</p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="secondary-button" onClick={() => setBulkModalOpen(true)} type="button">
              <SlidersHorizontal size={18} />
              ตั้งค่าชำระเงินหลายร้าน
            </button>
            <button className="primary-button" onClick={startNew} type="button">
              <Plus size={18} weight="bold" />
              ร้านใหม่
            </button>
          </div>
        </div>

        <div className="shop-catalog__toolbar">
          <label className="shop-search-field">
            <MagnifyingGlass aria-hidden="true" size={20} />
            <input
              aria-label="ค้นหาร้าน"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ค้นหารหัส ชื่อร้าน หรือรหัสศูนย์ราชการ"
              value={query}
            />
          </label>
          <div className="shop-catalog__filters">
            <select 
              aria-label="กรองตึก"
              className="shop-filter-button"
              onChange={(e) => {
                setBuildingFilter(e.target.value);
                setZoneFilter('');
              }}
              value={buildingFilter}
            >
              <option value="">ทุกตึก</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
              ))}
            </select>
            <select 
              aria-label="กรองโซนย่อย"
              className="shop-filter-button"
              disabled={!buildingFilter}
              onChange={(e) => setZoneFilter(e.target.value)}
              value={zoneFilter}
            >
              <option value="">ทุกโซน</option>
              {zones.filter((z) => z.building_id === buildingFilter).map((z) => (
                <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
              ))}
            </select>
            <span className="shop-catalog__count">พบ {filteredShops.length} ร้าน</span>
          </div>
        </div>
        <div className="shop-card-grid">
          {pagedShops.map((shop) => {
            const building = buildings.find((item) => item.id === shop.building_id);
            const zone = zones.find((item) => item.id === shop.zone_id);
            const imageUrl = shopImageUrls[shop.id];
            return (
              <button
                aria-pressed={draft.id === shop.id}
                className={`shop-directory-card ${draft.id === shop.id ? 'shop-directory-card--selected' : ''}`}
                key={shop.id}
                onClick={() => selectShop(shop)}
                type="button"
              >
                <span className="shop-directory-card__visual">
                  {imageUrl && !failedShopImages[shop.id] ? (
                    <img alt="" onError={() => setFailedShopImages((current) => ({ ...current, [shop.id]: true }))} src={imageUrl} />
                  ) : <Storefront aria-hidden="true" size={40} weight="duotone" />}
                  <span className={`shop-directory-card__status shop-directory-card__status--${shop.status}`}>{shop.status === 'active' ? 'ใช้งาน' : 'พักใช้งาน'}</span>
                </span>
                <span className="shop-directory-card__body">
                  <span className="shop-directory-card__code">{shop.code}</span>
                  <strong>{shop.name}</strong>
                  <span className="shop-directory-card__location"><Buildings aria-hidden="true" size={16} />{building?.name ?? 'ไม่พบตึก'}</span>
                  <span className="shop-directory-card__location"><MapPin aria-hidden="true" size={16} />{zone?.name ?? shop.floor_or_zone}</span>
                  {shop.contact_phone ? <span className="shop-directory-card__phone"><Phone aria-hidden="true" size={15} />{shop.contact_phone}</span> : <span className="shop-directory-card__phone shop-directory-card__phone--empty">ยังไม่มีเบอร์ผู้ติดต่อ</span>}
                </span>
                <span className="shop-directory-card__footer">
                  <span>{shop.normal_rounds_per_day} รอบ/วัน</span>
                  <CaretRight aria-hidden="true" size={18} weight="bold" />
                </span>
              </button>
            );
          })}
          {filteredShops.length === 0 ? (
            <div className="shop-catalog__empty"><ImageSquare aria-hidden="true" size={32} weight="duotone" /><strong>ไม่พบร้านที่ค้นหา</strong><span>ลองค้นหาด้วยรหัสร้านหรือชื่อร้านอีกครั้ง</span></div>
          ) : null}
        </div>
        {totalPages > 1 ? (
          <div className="shop-catalog__pagination">
            <button
              className="shop-filter-button"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              type="button"
            >‹ ก่อนหน้า</button>
            <span className="shop-catalog__page-info">หน้า {page + 1} / {totalPages}</span>
            <button
              className="shop-filter-button"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              type="button"
            >ถัดไป ›</button>
          </div>
        ) : null}
      </section>

      {editorOpen ? (
        <div className="modal-backdrop shop-settings-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeEditor();
        }}>
          <section aria-labelledby="shop-editor-title" aria-modal="true" className="panel shop-settings-editor shop-settings-dialog" role="dialog">
        <div className="panel-header">
          <div>
            <p className="eyebrow">ตั้งค่าร้านค้า</p>
            <h2 id="shop-editor-title">{draft.id ? `แก้ไข ${draft.name}` : 'เพิ่มร้านใหม่'}</h2>
          </div>
          <div className="shop-settings-dialog__actions">
            {draft.id && draft.status === 'active' ? (
              <button className="ghost-button" disabled={saving} onClick={() => void deactivateShop()} type="button">
                ปิดร้าน / ย้ายออก
              </button>
            ) : null}
            <button aria-label="ปิดหน้าต่างข้อมูลร้าน" autoFocus className="shop-settings-dialog__close" disabled={saving || savingTank} onClick={closeEditor} type="button">
              <X aria-hidden="true" size={22} />
            </button>
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
          <p className="muted">ร้านที่เปิดใช้งานจะปรากฏในรอบส่งใหม่ทั้งหมด พนักงานเลือกเองว่าจะไปร้านใด การปิดร้านจะเก็บประวัติเดิมไว้ และต้องรับคืนถังเช่าให้ครบก่อน</p>
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

        <ShopImageEditor
          onShopSaved={(savedShop) => setShops((current) => current.map((shop) => shop.id === savedShop.id ? { ...shop, image_path: savedShop.image_path } : shop))}
          shop={selectedShop}
        />

        {draft.id ? (
          <>
            <ShopPaymentProfileEditor shopId={draft.id} shopName={draft.name} />
            <ShopSpecialPriceEditor iceTypes={iceTypes} shopId={draft.id} shopName={draft.name} />
          </>
        ) : null}
          </section>
        </div>
      ) : null}

      {bulkModalOpen ? (
        <BulkPaymentSetupModal
          buildings={buildings}
          onClose={() => setBulkModalOpen(false)}
          onSuccess={() => void loadSettings()}
          shops={shops}
          zones={zones}
        />
      ) : null}

      <ShopReadinessPanel />
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
