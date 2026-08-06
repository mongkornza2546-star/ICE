import { ChangeEvent, FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Buildings, CaretRight, CheckCircle, Clock, ClockCounterClockwise, CreditCard, Eye, FileText, FileXls, GearSix, GridFour, IdentificationCard, ImageSquare, ListBullets, MagnifyingGlass, MapPin, Phone, Plus, Receipt, SlidersHorizontal, Storefront, Tag, UploadSimple, User, Warning, X } from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import { env } from './lib/env';
import { parseShopImportFile, type ShopImportRow } from './lib/shopImport';
import type { BuildingOption, BuildingZoneOption, ShopSetting, IceTypeOption } from './types/app';
import { ShopImageEditor } from './features/admin-reference-settings/components/ShopImageEditor';
import { ShopPaymentProfileEditor } from './features/shop-settings/components/ShopPaymentProfileEditor';
import { ShopSpecialPriceEditor } from './features/shop-settings/components/ShopSpecialPriceEditor';
import { BulkPaymentSetupModal } from './features/shop-settings/components/BulkPaymentSetupModal';
import { BulkShopPriceSetupModal } from './features/shop-settings/components/BulkShopPriceSetupModal';
import { ShopPurchaseHistory } from './features/shop-settings/components/ShopPurchaseHistory';
import { getShopImageSignedUrls, loadPOSReadinessReport } from './features/admin-reference-settings/adminReferenceSettingsService';
import { matchesActiveFilter, type ActiveFilter } from './features/admin-reference-settings/referenceEditorFilters';
import type { POSReadinessReport } from './types/app';


const TANK_IMAGE_BUCKET = 'tank-images';
const MAX_TANK_IMAGE_SIZE = 5 * 1024 * 1024;
const SHOP_IMAGE_URL_REFRESH_MS = 55 * 60 * 1000;
const SHOP_IMAGE_URL_RETRY_MS = 60 * 1000;
const SHOP_CODE_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
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

export function ShopSettings({
  allowReadOnlyPreview = false,
  isActive = true,
  readOnly = false,
}: {
  allowReadOnlyPreview?: boolean;
  isActive?: boolean;
  readOnly?: boolean;
}) {
  const managementReadOnly = readOnly || env.isDemoMode;
  const historyOnlyPreview = managementReadOnly && allowReadOnlyPreview;
  const [shops, setShops] = useState<ShopSetting[]>([]);
  const [buildings, setBuildings] = useState<BuildingOption[]>([]);
  const [zones, setZones] = useState<BuildingZoneOption[]>([]);
  const [iceTypes, setIceTypes] = useState<IceTypeOption[]>([]);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkPriceModalOpen, setBulkPriceModalOpen] = useState(false);
  const [draft, setDraft] = useState<ShopDraft>(emptyDraft);
  const [query, setQuery] = useState('');
  const [buildingFilter, setBuildingFilter] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [shopFilter] = useState<ActiveFilter>('all');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 12;
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTab, setEditorTab] = useState<'basic' | 'assets' | 'payment' | 'prices' | 'history'>('basic');
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
  const [tankImagePreviewUrl, setTankImagePreviewUrl] = useState<string | null>(null);
  const [savingTank, setSavingTank] = useState(false);
  const [tankError, setTankError] = useState<string | null>(null);
  const [tankSuccess, setTankSuccess] = useState<string | null>(null);
  const [shopImageUrls, setShopImageUrls] = useState<Record<string, string>>({});
  const [failedShopImages, setFailedShopImages] = useState<Record<string, boolean>>({});
  const [loadedShopImages, setLoadedShopImages] = useState<Record<string, boolean>>({});
  const [readinessReport, setReadinessReport] = useState<POSReadinessReport | null>(null);
  const [readinessStatus, setReadinessStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [paymentFilter, setPaymentFilter] = useState<'all' | 'missing'>('all');
  const [posFilter, setPosFilter] = useState<'all' | 'ready' | 'issues'>('all');
  const [catalogView, setCatalogView] = useState<'grid' | 'list'>('grid');
  const importInputRef = useRef<HTMLInputElement>(null);
  const activeEditorTabRef = useRef<HTMLButtonElement>(null);

  const refreshReadiness = useCallback(async () => {
    setReadinessStatus('loading');
    setReadinessError(null);
    if (env.isDemoMode) {
      setReadinessReport({
        total_active_shops: 8,
        shops_ready_count: 5,
        shops_missing_payment_profile: 2,
        ice_types_missing_standard_price: 1,
        items: [
          { shop_id: 'demo-shop-1', shop_code: 'AA01', shop_name: 'ร้านครัวน้องทราย (เบอร์ 9)', has_payment_profile: true, missing_special_prices_count: 0, has_issues: false, issue_details: [] },
          { shop_id: 'demo-shop-2', shop_code: 'AA10', shop_name: 'ร้านกาแฟเขาทะลุ ชุมพร', has_payment_profile: true, missing_special_prices_count: 0, has_issues: false, issue_details: [] },
          { shop_id: 'demo-shop-3', shop_code: 'AA11', shop_name: 'ร้านกาแฟ ลาเบล่า', has_payment_profile: true, missing_special_prices_count: 0, has_issues: false, issue_details: [] },
          { shop_id: 'demo-shop-4', shop_code: 'AA12', shop_name: 'ร้านมัน คอฟฟี่คอร์', has_payment_profile: false, missing_special_prices_count: 0, has_issues: true, issue_details: ['ยังไม่มี Payment Profile'] },
          { shop_id: 'demo-shop-5', shop_code: 'AA13', shop_name: 'ร้านข้าวมันไก่ศรีราชา', has_payment_profile: true, missing_special_prices_count: 0, has_issues: false, issue_details: [] },
          { shop_id: 'demo-shop-6', shop_code: 'AA14', shop_name: 'ร้านผลไม้สดเพื่อสุขภาพ', has_payment_profile: false, missing_special_prices_count: 0, has_issues: true, issue_details: ['ยังไม่มี Payment Profile'] },
          { shop_id: 'demo-shop-7', shop_code: 'AA15', shop_name: 'ร้านของฝากเมืองชุมพร', has_payment_profile: true, missing_special_prices_count: 1, has_issues: true, issue_details: ['ไม่มีราคากลางน้ำแข็ง'] },
          { shop_id: 'demo-shop-8', shop_code: 'AA16', shop_name: 'ร้านอาหารตามสั่งป้าตื๊ด', has_payment_profile: true, missing_special_prices_count: 0, has_issues: false, issue_details: [] },
        ],
      });
      setReadinessStatus('ready');
      return;
    }
    if (!supabase) {
      setReadinessReport(null);
      setReadinessError('ยังไม่ได้ตั้งค่า Supabase สำหรับรายงานความพร้อม POS');
      setReadinessStatus('error');
      return;
    }
    try {
      setReadinessReport(await loadPOSReadinessReport());
      setReadinessStatus('ready');
    } catch (loadError) {
      setReadinessReport(null);
      setReadinessError(loadError instanceof Error ? loadError.message : 'โหลดรายงานความพร้อม POS ไม่สำเร็จ');
      setReadinessStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void refreshDirectoryData();
  }, [isActive, refreshReadiness]);

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
    if (!editorOpen) return;
    const animationFrame = window.requestAnimationFrame(() => {
      const activeTab = activeEditorTabRef.current;
      if (activeTab && typeof activeTab.scrollIntoView === 'function') {
        activeTab.scrollIntoView({ block: 'nearest', inline: 'center' });
      }
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [editorOpen, editorTab]);

  async function loadSettings() {
    if (env.isDemoMode) {
      const demoBuildings = [
        { id: 'demo-building-a', code: 'A', name: 'อาคาร A' },
        { id: 'demo-building-b', code: 'B', name: 'อาคาร B' },
        { id: 'demo-building-c', code: 'C', name: 'อาคาร C' },
      ];
      const demoZones = demoBuildings.map((building) => ({ id: `demo-zone-${building.code.toLowerCase()}`, building_id: building.id, code: building.code, name: `โซน ${building.code}`, sort_order: 1, is_active: true }));
      const demoShopNames = ['ร้านครัวน้องทราย (เบอร์ 9)', 'ร้านกาแฟเขาทะลุ ชุมพร', 'ร้านกาแฟ ลาเบล่า', 'ร้านมัน คอฟฟี่คอร์', 'ร้านข้าวมันไก่ศรีราชา', 'ร้านผลไม้สดเพื่อสุขภาพ', 'ร้านของฝากเมืองชุมพร', 'ร้านอาหารตามสั่งป้าตื๊ด'];
      const demoCodes = ['AA01', 'AA10', 'AA11', 'AA12', 'AA13', 'AA14', 'AA15', 'AA16'];
      setBuildings(demoBuildings);
      setZones(demoZones);
      setIceTypes([{ id: 'demo-ice', code: 'BLOCK', name: 'น้ำแข็งก้อน', unit: 'ถุง' }]);
      setShops(demoShopNames.map((name, index) => {
        const building = demoBuildings[index % demoBuildings.length];
        return { id: `demo-shop-${index + 1}`, code: demoCodes[index], name, image_path: null, building_id: building.id, zone_id: `demo-zone-${building.code.toLowerCase()}`, floor_or_zone: `โซน ${building.code}`, government_shop_code: null, contact_name: null, contact_phone: index === 3 || index === 6 ? null : `08${index + 1}-234-567${index}`, normal_rounds_per_day: 1, access_note: null, status: 'active' };
      }));
      setLoading(false);
      return;
    }
    if (!supabase) {
      setError('ยังไม่ได้ตั้งค่า Supabase สำหรับหน้านี้');
      setLoading(false);
      return;
    }
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

  async function refreshDirectoryData() {
    await Promise.all([loadSettings(), refreshReadiness()]);
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
      const matchesSearch = !needle || `${shop.code} ${shop.government_shop_code ?? ''} ${shop.name} ${shop.contact_phone ?? ''}`.toLocaleLowerCase('th').includes(needle);
      const matchesBuilding = !buildingFilter || shop.building_id === buildingFilter;
      const matchesZone = !zoneFilter || shop.zone_id === zoneFilter;
      const readiness = readinessReport?.items.find((item) => item.shop_id === shop.id);
      const matchesPayment = readinessStatus !== 'ready' || paymentFilter !== 'missing' || readiness?.has_payment_profile === false;
      const matchesPos = readinessStatus !== 'ready' || posFilter === 'all'
        || (posFilter === 'ready' ? readiness?.has_issues === false : readiness?.has_issues === true);
      return matchesSearch && matchesActiveFilter(shop.status === 'active', shopFilter) && matchesBuilding && matchesZone && matchesPayment && matchesPos;
    }).sort((left, right) => SHOP_CODE_COLLATOR.compare(left.code, right.code));
  }, [query, shopFilter, buildingFilter, zoneFilter, paymentFilter, posFilter, readinessReport, readinessStatus, shops]);

  // Reset to page 0 whenever filters change
  useEffect(() => { setPage(0); }, [query, shopFilter, buildingFilter, zoneFilter, paymentFilter, posFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredShops.length / PAGE_SIZE));
  const pagedShops = useMemo(
    () => filteredShops.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filteredShops, page],
  );
  const visibleShopsWithImages = useMemo(
    () => pagedShops.filter((shop) => shop.image_path),
    [pagedShops],
  );

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    if (visibleShopsWithImages.length === 0) {
      setShopImageUrls({});
      setFailedShopImages({});
      setLoadedShopImages({});
      return () => { cancelled = true; };
    }

    const refreshImageUrls = async () => {
      let nextRefreshMs = SHOP_IMAGE_URL_REFRESH_MS;
      try {
        const urlsByPath = await getShopImageSignedUrls(visibleShopsWithImages.map((shop) => shop.image_path!));
        if (!cancelled) {
          setShopImageUrls(Object.fromEntries(
            visibleShopsWithImages.flatMap((shop) => {
              const url = urlsByPath[shop.image_path!];
              return url ? [[shop.id, url]] : [];
            }),
          ));
          setFailedShopImages({});
          setLoadedShopImages({});
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
  }, [visibleShopsWithImages]);

  const selectShop = (shop: ShopSetting) => {
    if (managementReadOnly && !allowReadOnlyPreview) return;
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
    setEditorTab(allowReadOnlyPreview ? 'history' : 'basic');
    setEditorOpen(true);
  };

  const startNew = () => {
    if (managementReadOnly) return;
    setDraft({
      ...emptyDraft,
      building_id: buildings[0]?.id ?? '',
      zone_id: zones.find((zone) => zone.building_id === buildings[0]?.id)?.id ?? '',
    });
    setError(null);
    setSuccess(null);
    resetTankDraft();
    setEditorTab('basic');
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

  useEffect(() => {
    if (!tankImageFile) {
      setTankImagePreviewUrl(null);
      return;
    }

    const previewUrl = URL.createObjectURL(tankImageFile);
    setTankImagePreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [tankImageFile]);

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
    if (managementReadOnly || !supabase || !draft.id) return;
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
    if (managementReadOnly || !supabase || !window.confirm(`ยืนยันว่าร้านคืนถัง ${tank.tank_code} แล้ว`)) return;
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
    if (managementReadOnly || !supabase || !draft.id) return;
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
      await refreshDirectoryData();
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
    if (managementReadOnly || !supabase || importRows.length === 0) return;
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
      await refreshDirectoryData();
    }
    setImporting(false);
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (managementReadOnly || !supabase) return;
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
    await refreshDirectoryData();
    setDraft((current) => ({ ...current, id: data as string }));
    setSaving(false);
  };

  if (loading) return <p className="empty-text">กำลังโหลดข้อมูลร้าน...</p>;

  const activeShopCount = readinessReport?.total_active_shops ?? shops.filter((shop) => shop.status === 'active').length;
  const readyShopCount = readinessReport?.shops_ready_count ?? 0;
  const missingProfileCount = readinessReport?.shops_missing_payment_profile ?? 0;
  const missingPriceCount = readinessReport?.items.filter((item) => item.missing_special_prices_count > 0).length ?? 0;
  const readinessAvailable = readinessStatus === 'ready' && readinessReport !== null;
  const readinessMetric = (value: number) => readinessStatus === 'loading' ? '…' : readinessStatus === 'error' ? '—' : value;
  const editorBuilding = buildings.find((building) => building.id === draft.building_id);
  const editorZone = zones.find((zone) => zone.id === draft.zone_id);

  return (
    <div className="shop-settings-page">
      <input accept=".xlsx" className="shop-import-file-input" onChange={chooseImportFile} ref={importInputRef} type="file" />
      <header className="shop-page-heading">
        <div>
          <h1>ร้านค้า</h1>
          <p>จัดการร้านค้า สถานะการตั้งค่า POS และข้อมูลสำคัญของร้านค้าในศูนย์ราชการ</p>
        </div>
        <div className="shop-page-actions">
          <button className="primary-button shop-page-actions__new" onClick={startNew} type="button"><Plus size={21} weight="regular" />ร้านใหม่</button>
          <button className="secondary-button" onClick={() => importInputRef.current?.click()} type="button"><UploadSimple size={19} />นำเข้า Excel</button>
          <button className="secondary-button" onClick={() => { if (!managementReadOnly) setBulkPriceModalOpen(true); }} type="button"><SlidersHorizontal size={19} />ตั้งค่าหลายร้าน</button>
          <button className="secondary-button" onClick={() => { if (!managementReadOnly) setBulkModalOpen(true); }} type="button"><Receipt size={19} />ตั้งค่าประเภทการรับเงิน</button>
        </div>
      </header>

      <section aria-label="สรุปสถานะร้าน" className="shop-summary-grid">
        <article className="shop-summary-card shop-summary-card--blue"><span className="shop-summary-card__icon"><Storefront size={35} weight="duotone" /></span><div><p>ร้านค้าทั้งหมด</p><strong>{activeShopCount}</strong><small>ร้าน</small><a href="#shop-directory">ดูรายละเอียดทั้งหมด <CaretRight size={14} /></a></div></article>
        <article className="shop-summary-card shop-summary-card--green"><span className="shop-summary-card__icon"><CheckCircle size={35} weight="duotone" /></span><div><p>พร้อมใช้งาน POS</p><strong>{readinessMetric(readyShopCount)}</strong><small>ร้าน {readinessAvailable && activeShopCount ? `(${Math.round((readyShopCount / activeShopCount) * 100)}%)` : ''}</small><em>พร้อมรับออเดอร์</em></div></article>
        <article className="shop-summary-card shop-summary-card--orange"><span className="shop-summary-card__icon"><CreditCard size={35} weight="duotone" /></span><div><p>ยังไม่มี Payment Profile</p><strong>{readinessMetric(missingProfileCount)}</strong><small>ร้าน {readinessAvailable && activeShopCount ? `(${Math.round((missingProfileCount / activeShopCount) * 100)}%)` : ''}</small><em>ตั้งค่าให้เสร็จเพื่อขายได้</em></div></article>
        <article className="shop-summary-card shop-summary-card--red"><span className="shop-summary-card__icon"><Warning size={35} weight="duotone" /></span><div><p>ยังไม่มีราคากลางน้ำแข็ง</p><strong>{readinessMetric(missingPriceCount)}</strong><small>ร้าน</small><em>ตั้งราคากลางก่อนขาย</em></div></article>
      </section>

      {importFileName || importError || importSuccess ? <section className="shop-import-inline">
        <div><FileXls size={25} weight="duotone" /><span><strong>{importFileName || 'นำเข้ารายการร้านค้า'}</strong><small>{importRows.length ? `พบ ${importRows.length} ร้านในไฟล์` : 'เลือกไฟล์ Excel เพื่อเริ่มนำเข้า'}</small></span></div>
        <div className="shop-import-inline__actions"><a download href="/templates/shop-import-template.xlsx">ดาวน์โหลดแม่แบบ</a><button className="primary-button" disabled={managementReadOnly || importing || importRows.length === 0} onClick={importCatalog} type="button">{importing ? 'กำลังนำเข้า...' : `ยืนยันนำเข้า ${importRows.length} ร้าน`}</button></div>
        {importError ? <p className="error-text">{importError}</p> : null}{importSuccess ? <p className="success-text">{importSuccess}</p> : null}
      </section> : null}

      {readinessStatus === 'error' ? (
        <div className="shop-readiness-error" role="alert">
          <span>ไม่สามารถโหลดสถานะความพร้อม POS ได้{readinessError ? `: ${readinessError}` : ''}</span>
          <button className="ghost-button" onClick={() => void refreshReadiness()} type="button">ลองใหม่</button>
        </div>
      ) : null}

      <section className="shop-catalog" id="shop-directory">
        <div className="shop-catalog__toolbar">
          <label className="shop-search-field"><MagnifyingGlass aria-hidden="true" size={20} /><input aria-label="ค้นหาร้าน" onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาด้วยรหัสร้าน / ชื่อร้าน / ศูนย์ / เบอร์โทร" value={query} /></label>
          <div className="shop-catalog__filters">
            <select aria-label="กรองตึก" className="shop-filter-button" onChange={(e) => { setBuildingFilter(e.target.value); setZoneFilter(''); }} value={buildingFilter}><option value="">อาคาร: ทั้งหมด</option>{buildings.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select>
            <select aria-label="กรองโซนย่อย" className="shop-filter-button" disabled={!buildingFilter} onChange={(e) => setZoneFilter(e.target.value)} value={zoneFilter}><option value="">โซน: ทั้งหมด</option>{zones.filter((z) => z.building_id === buildingFilter).map((z) => <option key={z.id} value={z.id}>{z.code} · {z.name}</option>)}</select>
            <select aria-label="กรองประเภทรายรับ" className="shop-filter-button" disabled={!readinessAvailable} onChange={(e) => setPaymentFilter(e.target.value as 'all' | 'missing')} value={paymentFilter}><option value="all">ประเภทรายรับ: ทั้งหมด</option><option value="missing">ยังไม่มี Payment Profile</option></select>
            <select aria-label="กรองความพร้อม POS" className="shop-filter-button" disabled={!readinessAvailable} onChange={(e) => setPosFilter(e.target.value as 'all' | 'ready' | 'issues')} value={posFilter}><option value="all">สถานะความพร้อม POS: ทั้งหมด</option><option value="ready">พร้อม POS</option><option value="issues">ต้องตั้งค่าเพิ่ม</option></select>
          </div>
          <div className="shop-view-switcher" aria-label="รูปแบบการแสดงผล"><button aria-label="แสดงแบบการ์ด" className={catalogView === 'grid' ? 'is-active' : ''} onClick={() => setCatalogView('grid')} type="button"><GridFour size={20} weight="bold" />การ์ด</button><button aria-label="แสดงแบบรายการ" className={catalogView === 'list' ? 'is-active' : ''} onClick={() => setCatalogView('list')} type="button"><ListBullets size={20} weight="bold" />ตาราง</button></div>
        </div>
        <div className={`shop-card-grid shop-card-grid--${catalogView}`}>
          {pagedShops.map((shop) => {
            const building = buildings.find((item) => item.id === shop.building_id);
            const zone = zones.find((item) => item.id === shop.zone_id);
            const imageUrl = shopImageUrls[shop.id];
            const imageLoaded = loadedShopImages[shop.id];
            const readiness = readinessReport?.items.find((item) => item.shop_id === shop.id);
            const readinessLabel = shop.status !== 'active'
              ? 'พักใช้งาน'
              : readinessStatus === 'loading'
                ? 'กำลังโหลด'
                : readinessStatus === 'error'
                  ? 'ไม่ทราบ'
                  : 'ไม่พบข้อมูล';
            const paymentClass = readinessAvailable && readiness
              ? readiness.has_payment_profile ? 'is-blue' : 'is-orange'
              : 'is-neutral';
            const paymentLabel = readinessAvailable && readiness
              ? readiness.has_payment_profile ? 'พร้อมแล้ว' : 'ไม่มี Payment Profile'
              : readinessLabel;
            const posClass = readinessAvailable && readiness
              ? readiness.has_issues ? 'is-red' : 'is-green'
              : 'is-neutral';
            const posLabel = readinessAvailable && readiness
              ? readiness.has_issues ? (readiness.issue_details[0] ?? 'ต้องตั้งค่า') : 'พร้อม POS'
              : readinessLabel;
            return (
              <button
                aria-label={`${shop.code} ${shop.name}`}
                aria-pressed={draft.id === shop.id}
                className={`shop-directory-card ${draft.id === shop.id ? 'shop-directory-card--selected' : ''}`}
                key={shop.id}
                onClick={() => selectShop(shop)}
                type="button"
              >
                <span className="shop-directory-card__visual">
                  {imageUrl && !failedShopImages[shop.id] ? (
                    <img alt={`รูปภาพร้าน ${shop.name}`} onError={() => setFailedShopImages((current) => ({ ...current, [shop.id]: true }))} onLoad={() => setLoadedShopImages((current) => ({ ...current, [shop.id]: true }))} src={imageUrl} />
                  ) : null}
                  {!imageLoaded || !imageUrl || failedShopImages[shop.id] ? <><Storefront aria-hidden="true" size={38} weight="duotone" /><small className="shop-directory-card__photo-status">{shop.image_path ? (imageUrl && !failedShopImages[shop.id] ? 'กำลังโหลดรูป...' : 'แสดงรูปไม่ได้') : 'ยังไม่มีรูป'}</small></> : null}
                </span>
                <span className="shop-directory-card__body">
                  <span className="shop-directory-card__heading"><span className="shop-directory-card__code">{shop.code}</span><span className={`shop-directory-card__status shop-directory-card__status--${shop.status}`}>{shop.status === 'active' ? 'ใช้งาน' : 'พักใช้งาน'}</span></span>
                  <strong>{shop.name}</strong>
                  <span className="shop-directory-card__locations"><span className="shop-directory-card__location"><Buildings aria-hidden="true" size={15} />{building?.name ?? 'ไม่พบตึก'}</span><span className="shop-directory-card__location"><MapPin aria-hidden="true" size={15} />{zone?.name ?? shop.floor_or_zone}</span></span>
                  <span className="shop-directory-card__readiness"><span><small>ประเภทรายรับ</small><b className={paymentClass}>{paymentLabel}</b></span><span><small>สถานะ POS</small><b className={posClass}>{posLabel}</b></span></span>
                  {shop.contact_phone ? <span className="shop-directory-card__phone"><Phone aria-hidden="true" size={15} />{shop.contact_phone}</span> : <span className="shop-directory-card__phone shop-directory-card__phone--empty">ไม่มีเบอร์โทรศัพท์</span>}
                </span>
                <span className="shop-directory-card__footer">
                  <span><Eye aria-hidden="true" size={16} />รายละเอียด</span><span><SlidersHorizontal aria-hidden="true" size={16} />แก้ไข</span><span><GearSix aria-hidden="true" size={16} />ตั้งค่า POS</span>
                </span>
              </button>
            );
          })}
          {filteredShops.length === 0 ? (
            <div className="shop-catalog__empty"><ImageSquare aria-hidden="true" size={32} weight="duotone" /><strong>ไม่พบร้านที่ค้นหา</strong><span>ลองค้นหาด้วยรหัสร้านหรือชื่อร้านอีกครั้ง</span></div>
          ) : null}
        </div>
        <div className="shop-catalog__footer-row"><span className="shop-catalog__count"><span>พบ {filteredShops.length} ร้าน</span><span> · แสดง {pagedShops.length ? page * PAGE_SIZE + 1 : 0} - {Math.min((page + 1) * PAGE_SIZE, filteredShops.length)}</span></span>
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
        ) : null}</div>
      </section>

      {editorOpen ? (
        <div className="modal-backdrop shop-settings-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeEditor();
        }}>
          <section aria-label={draft.id ? `แก้ไข ${draft.name}` : 'เพิ่มร้านใหม่'} aria-labelledby="shop-editor-title" aria-modal="true" className="panel shop-settings-editor shop-settings-dialog" role="dialog">
            <header className="shop-editor-hero">
              <span className="shop-editor-hero__icon"><Storefront size={32} weight="fill" /></span>
              <div className="shop-editor-hero__copy">
                <p className="eyebrow">ตั้งค่าร้านค้า</p>
                <h2 id="shop-editor-title">{draft.id ? <span className="employee-visually-hidden">แก้ไข </span> : null}{draft.name || 'เพิ่มร้านใหม่'}</h2>
                <div className="shop-editor-hero__badges">
                  <span>รหัสร้าน: {draft.code || '—'}</span>
                  <span className={draft.status === 'active' ? 'is-active' : 'is-inactive'}>{draft.status === 'active' ? 'ใช้งาน' : 'พักใช้งาน'}</span>
                  {editorBuilding ? <span>{editorBuilding.code} · {editorBuilding.name}</span> : null}
                  {editorZone ? <span>โซนย่อย: {editorZone.name}</span> : null}
                </div>
              </div>
              <div className="shop-settings-dialog__actions">
                {draft.id && draft.status === 'active' && !historyOnlyPreview ? <button className="shop-editor-deactivate" disabled={saving} onClick={() => void deactivateShop()} type="button">ปิดร้าน / ย้ายออก</button> : null}
                <button aria-label="ปิดหน้าต่างข้อมูลร้าน" autoFocus className="shop-settings-dialog__close" disabled={saving || savingTank} onClick={closeEditor} type="button"><X aria-hidden="true" size={24} /></button>
              </div>
            </header>

            <section className="shop-editor-overview" aria-label="สรุปข้อมูลร้าน">
              <EditorStat icon={<IdentificationCard size={24} />} label="รหัสร้าน" value={draft.code || '—'} />
              <EditorStat icon={<Storefront size={24} />} label="ชื่อร้าน" value={draft.name || '—'} />
              <EditorStat icon={<Buildings size={24} />} label="อาคาร / โซนย่อย" value={editorBuilding && editorZone ? `${editorBuilding.code} · ${editorZone.name}` : '—'} />
              <EditorStat icon={<User size={24} />} label="ผู้ติดต่อ" value={draft.contact_name || '—'} />
              <EditorStat icon={<Phone size={24} />} label="เบอร์โทร" value={draft.contact_phone || '—'} />
              <EditorStat icon={<Clock size={24} />} label="รอบปกติต่อวัน" value={`${draft.normal_rounds_per_day} รอบ`} />
              <EditorStat icon={<Storefront size={24} />} label="สถานะร้าน" value={draft.status === 'active' ? 'ใช้งาน' : 'พักใช้งาน'} tone={draft.status} />
              <EditorStat icon={<FileText size={24} />} label="หมายเหตุการเข้าถึง" value={draft.access_note || '—'} />
            </section>

            <nav className="shop-editor-tabs" aria-label="หมวดหมู่การตั้งค่าร้าน">
              <button className={editorTab === 'basic' ? 'is-active' : ''} disabled={historyOnlyPreview} onClick={() => setEditorTab('basic')} ref={editorTab === 'basic' ? activeEditorTabRef : undefined} type="button"><FileText size={21} />ข้อมูลพื้นฐาน</button>
              <button className={editorTab === 'assets' ? 'is-active' : ''} disabled={historyOnlyPreview} onClick={() => setEditorTab('assets')} ref={editorTab === 'assets' ? activeEditorTabRef : undefined} type="button"><ImageSquare size={21} />ถังเช่าและรูปภาพ</button>
              <button className={editorTab === 'payment' ? 'is-active' : ''} disabled={historyOnlyPreview} onClick={() => setEditorTab('payment')} ref={editorTab === 'payment' ? activeEditorTabRef : undefined} type="button"><CreditCard size={21} />การชำระเงิน</button>
              <button className={editorTab === 'prices' ? 'is-active' : ''} disabled={historyOnlyPreview} onClick={() => setEditorTab('prices')} ref={editorTab === 'prices' ? activeEditorTabRef : undefined} type="button"><Tag size={21} />ราคาพิเศษน้ำแข็ง</button>
              <button className={editorTab === 'history' ? 'is-active' : ''} onClick={() => setEditorTab('history')} ref={editorTab === 'history' ? activeEditorTabRef : undefined} type="button"><ClockCounterClockwise size={21} />ประวัติการซื้อ</button>
            </nav>

            {error ? <p className="error-text shop-editor-feedback" role="alert">{error}</p> : null}
            {success ? <p aria-live="polite" className="success-text shop-editor-feedback">{success}</p> : null}

            {!historyOnlyPreview ? <form className="settings-form shop-editor-form" hidden={editorTab !== 'basic'} onSubmit={handleSave}>
              <div className="shop-editor-fields">
                <TextField label="รหัสร้าน" required value={draft.code} onChange={(code) => setDraft({ ...draft, code })} />
                <TextField label="รหัสศูนย์ราชการ" value={draft.government_shop_code} onChange={(government_shop_code) => setDraft({ ...draft, government_shop_code })} />
                <TextField label="ชื่อร้าน" required value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
                <label>อาคาร<select required value={draft.building_id} onChange={(event) => { const building_id = event.target.value; setDraft({ ...draft, building_id, zone_id: zones.find((zone) => zone.building_id === building_id)?.id ?? '' }); }}><option value="">เลือกตึก</option>{buildings.map((building) => <option key={building.id} value={building.id}>{building.code} · {building.name}</option>)}</select></label>
                <label>โซนย่อย<select required value={draft.zone_id} onChange={(event) => setDraft({ ...draft, zone_id: event.target.value })}><option value="">เลือกโซนย่อย</option>{zones.filter((zone) => zone.building_id === draft.building_id).map((zone) => <option key={zone.id} value={zone.id}>{zone.code} · {zone.name}</option>)}</select></label>
                <TextField label="ผู้ติดต่อ" value={draft.contact_name} onChange={(contact_name) => setDraft({ ...draft, contact_name })} />
                <TextField label="เบอร์โทร" value={draft.contact_phone} onChange={(contact_phone) => setDraft({ ...draft, contact_phone })} />
                <label>สถานะร้าน<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as ShopDraft['status'] })}><option value="active">ใช้งาน</option><option value="inactive">พักใช้งาน</option></select></label>
                <label className="shop-editor-field--rounds">รอบปกติต่อวัน<input min={1} required type="number" value={draft.normal_rounds_per_day} onChange={(event) => setDraft({ ...draft, normal_rounds_per_day: Math.max(1, Number(event.target.value) || 1) })} /></label>
              </div>
              <label>หมายเหตุการเข้าถึง<textarea rows={3} placeholder="ระบุหมายเหตุการเข้าถึง (ถ้ามี)" value={draft.access_note} onChange={(event) => setDraft({ ...draft, access_note: event.target.value })} /></label>
              <footer className="shop-editor-savebar"><button className="secondary-button" disabled={saving} onClick={closeEditor} type="button">ยกเลิก</button><button className="primary-button" disabled={saving} type="submit">{saving ? 'กำลังบันทึก...' : 'บันทึกข้อมูลร้าน'}</button></footer>
            </form> : null}

            {!historyOnlyPreview ? <div className="shop-editor-tab-content" hidden={editorTab !== 'assets'}>
              <ShopImageEditor
                onShopSaved={(savedShop) => setShops((current) => current.map((shop) => shop.id === savedShop.id ? { ...shop, image_path: savedShop.image_path } : shop))}
                shop={selectedShop}
              />
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
                {tankImagePreviewUrl ? (
                  <div className="rented-tank-preview">
                    <img alt="ตัวอย่างรูปถังที่เลือก" src={tankImagePreviewUrl} />
                  </div>
                ) : null}
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
            </div> : null}
            {!historyOnlyPreview ? <div className="shop-editor-tab-content" hidden={editorTab !== 'payment'}>{draft.id ? <ShopPaymentProfileEditor onSaved={refreshReadiness} shopId={draft.id} shopName={draft.name} /> : <p className="muted">บันทึกข้อมูลร้านก่อน แล้วจึงตั้งค่าการชำระเงิน</p>}</div> : null}
            {!historyOnlyPreview ? <div className="shop-editor-tab-content" hidden={editorTab !== 'prices'}>{draft.id ? <ShopSpecialPriceEditor iceTypes={iceTypes} onSaved={refreshReadiness} shopId={draft.id} shopName={draft.name} /> : <p className="muted">บันทึกข้อมูลร้านก่อน แล้วจึงตั้งค่าราคาพิเศษน้ำแข็ง</p>}</div> : null}
            <div className="shop-editor-tab-content" hidden={editorTab !== 'history'}><ShopPurchaseHistory isActive={editorTab === 'history'} shopId={draft.id} /></div>
          </section>
        </div>
      ) : null}

      {bulkModalOpen ? (
        <BulkPaymentSetupModal
          buildings={buildings}
          onClose={() => setBulkModalOpen(false)}
          onSuccess={() => void refreshDirectoryData()}
          shops={shops}
          zones={zones}
        />
      ) : null}

      {bulkPriceModalOpen ? (
        <BulkShopPriceSetupModal
          buildings={buildings}
          iceTypes={iceTypes}
          onClose={() => setBulkPriceModalOpen(false)}
          onSuccess={() => void refreshDirectoryData()}
          shops={shops}
          zones={zones}
        />
      ) : null}
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

function EditorStat({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone?: 'active' | 'inactive' }) {
  return (
    <div className="shop-editor-stat">
      <span className="shop-editor-stat__icon">{icon}</span>
      <span><small>{label}</small><strong className={tone ? `is-${tone}` : ''}>{value}</strong></span>
    </div>
  );
}
