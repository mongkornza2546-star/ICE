import { type ChangeEvent, type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle,
  Circle,
  FunnelSimple,
  Info,
  ImageSquare,
  MagnifyingGlass,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { ALLOWED_SHOP_IMAGE_TYPES, MAX_SHOP_IMAGE_SIZE, type ShopImageSetting } from '../types';
import {
  getErrorMessage,
  getShopImageSignedUrl,
  uploadShopImage,
  updateShopImagePath,
  removeShopImageFiles,
} from '../adminReferenceSettingsService';
import {
  filterLabel,
  matchesActiveFilter,
  matchesQuery,
  nextFilter,
  type ActiveFilter,
} from '../referenceEditorFilters';

interface ShopImageEditorProps {
  shops: ShopImageSetting[];
  onShopSaved: (savedShop: ShopImageSetting) => void;
}

export function ShopImageEditor({ shops, onShopSaved }: ShopImageEditorProps) {
  const [selectedShopId, setSelectedShopId] = useState<string>(() => shops.length > 0 ? shops[0].id : '');
  const [shopQuery, setShopQuery] = useState('');
  const [shopFilter, setShopFilter] = useState<ActiveFilter>('all');

  const [shopPreviewUrl, setShopPreviewUrl] = useState<string | null>(null);
  const [shopPreviewLoading, setShopPreviewLoading] = useState(false);
  const [shopUploadFile, setShopUploadFile] = useState<File | null>(null);
  const [shopUploadPreviewUrl, setShopUploadPreviewUrl] = useState<string | null>(null);

  const [savingShopImage, setSavingShopImage] = useState(false);
  const [shopImageError, setShopImageError] = useState<string | null>(null);
  const [shopImageSuccess, setShopImageSuccess] = useState<string | null>(null);

  const filteredShops = useMemo(
    () => shops
      .filter((shop) => matchesQuery(shopQuery, [shop.code, shop.name]))
      .filter((shop) => matchesActiveFilter(shop.status === 'active', shopFilter)),
    [shopFilter, shopQuery, shops],
  );

  const selectedShop = useMemo(
    () => shops.find((shop) => shop.id === selectedShopId) ?? null,
    [selectedShopId, shops],
  );

  const shopPreviewSrc = shopUploadPreviewUrl ?? shopPreviewUrl;

  function chooseShop(shop: ShopImageSetting) {
    setSelectedShopId(shop.id);
    setShopUploadFile(null);
    setShopImageError(null);
    setShopImageSuccess(null);
  }

  useEffect(() => {
    if (!shopUploadFile) {
      setShopUploadPreviewUrl(null);
      return undefined;
    }

    const objectUrl = URL.createObjectURL(shopUploadFile);
    setShopUploadPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [shopUploadFile]);

  useEffect(() => {
    let cancelled = false;
    const imagePath = selectedShop?.image_path;

    if (shopUploadFile || !imagePath) {
      setShopPreviewLoading(false);
      setShopPreviewUrl(null);
      return undefined;
    }

    setShopPreviewLoading(true);
    setShopPreviewUrl(null);

    getShopImageSignedUrl(imagePath)
      .then((url) => {
        if (!cancelled) setShopPreviewUrl(url);
      })
      .catch(() => {
        // Handle error silently for preview
      })
      .finally(() => {
        if (!cancelled) setShopPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedShop?.image_path, shopUploadFile]);

  function chooseShopImageFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (file.size > MAX_SHOP_IMAGE_SIZE) {
      setShopUploadFile(null);
      setShopImageSuccess(null);
      setShopImageError('รูปต้องมีขนาดไม่เกิน 5 MB');
      return;
    }

    if (file.type && !ALLOWED_SHOP_IMAGE_TYPES.has(file.type)) {
      setShopUploadFile(null);
      setShopImageSuccess(null);
      setShopImageError('รองรับเฉพาะไฟล์ JPG, PNG หรือ WEBP');
      return;
    }

    setShopUploadFile(file);
    setShopImageError(null);
    setShopImageSuccess(null);
  }

  async function saveShopImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedShop) return;

    if (!shopUploadFile) {
      setShopImageError('กรุณาเลือกรูปร้านก่อนบันทึก');
      return;
    }

    setSavingShopImage(true);
    setShopImageError(null);
    setShopImageSuccess(null);

    const previousPath = selectedShop.image_path;

    try {
      const nextPath = await uploadShopImage(selectedShop.id, shopUploadFile);

      try {
        const savedShop = await updateShopImagePath(selectedShop.id, nextPath);
        
        if (previousPath && previousPath !== nextPath) {
          await removeShopImageFiles([previousPath]).catch(() => {
            // Ignore error when removing old file
          });
        }

        onShopSaved(savedShop);
        setShopUploadFile(null);
        setShopImageSuccess(previousPath ? 'อัปเดตรูปร้านแล้ว' : 'เพิ่มรูปร้านแล้ว');
      } catch (updateError) {
        await removeShopImageFiles([nextPath]).catch(() => {});
        throw updateError;
      }
    } catch (error) {
      setShopImageError(getErrorMessage(error));
    } finally {
      setSavingShopImage(false);
    }
  }

  async function removeShopImage() {
    if (!selectedShop) return;

    if (!selectedShop.image_path) {
      setShopImageError('ร้านนี้ยังไม่มีรูปในระบบ');
      return;
    }

    setSavingShopImage(true);
    setShopImageError(null);
    setShopImageSuccess(null);

    const previousPath = selectedShop.image_path;

    try {
      const savedShop = await updateShopImagePath(selectedShop.id, null);
      
      let removeError = false;
      try {
        await removeShopImageFiles([previousPath]);
      } catch (e) {
        removeError = true;
      }

      onShopSaved(savedShop);
      setShopUploadFile(null);
      setShopImageSuccess(removeError ? 'ลบการอ้างอิงรูปแล้ว แต่ลบไฟล์เก่าไม่สำเร็จ' : 'ลบรูปร้านแล้ว');
    } catch (error) {
      setShopImageError(getErrorMessage(error));
    } finally {
      setSavingShopImage(false);
    }
  }

  const shopFilterLabel = filterLabel(shopFilter);

  return (
    <section className="reference-editor-panel">
      <div className="reference-editor-panel__header">
        <span>3</span>
        <h2>จัดการรูปร้านค้า</h2>
      </div>

      <div className="reference-editor-panel__body">
        <div className="reference-editor-panel__column reference-editor-panel__column--list">
          <div className="reference-toolbar">
            <label className="reference-search-field">
              <MagnifyingGlass aria-hidden="true" size={20} />
              <input
                onChange={(event) => setShopQuery(event.target.value)}
                placeholder="ค้นหาร้าน"
                value={shopQuery}
              />
            </label>
            <button
              aria-label={`กรองร้าน: ${shopFilterLabel}`}
              className={`reference-filter-button ${shopFilter !== 'all' ? 'reference-filter-button--active' : ''}`}
              onClick={() => setShopFilter(nextFilter(shopFilter))}
              title={`กรองร้าน: ${shopFilterLabel}`}
              type="button"
            >
              <FunnelSimple size={20} />
            </button>
          </div>

          <div className="reference-list">
            {filteredShops.map((shop) => {
              const selected = selectedShopId === shop.id;
              return (
                <button
                  aria-current={selected ? 'true' : undefined}
                  className={`reference-list-item ${selected ? 'reference-list-item--selected' : ''}`}
                  key={shop.id}
                  onClick={() => chooseShop(shop)}
                  type="button"
                >
                  <span className="reference-list-item__radio" aria-hidden="true">
                    {selected ? <CheckCircle size={20} weight="fill" /> : <Circle size={20} />}
                  </span>
                  <span className="reference-list-item__body">
                    <strong>{shop.code}</strong>
                    <small>{shop.name}</small>
                  </span>
                  <span className="reference-list-item__tags">
                    <span className={`reference-pill ${shop.image_path ? 'reference-pill--blue' : 'reference-pill--gray'}`}>
                      {shop.image_path ? 'มีรูป' : 'ยังไม่มีรูป'}
                    </span>
                    <span className={`reference-pill ${shop.status === 'active' ? 'reference-pill--green' : 'reference-pill--gray'}`}>
                      {shop.status === 'active' ? 'ใช้งาน' : 'พักใช้งาน'}
                    </span>
                  </span>
                </button>
              );
            })}
            {filteredShops.length === 0 ? <p className="empty-text">ไม่พบร้านตามคำค้นหรือเงื่อนไขที่เลือก</p> : null}
          </div>

          <p className="reference-list__meta">
            แสดง {filteredShops.length === 0 ? 0 : 1}-{filteredShops.length} จาก {shops.length} ร้าน
          </p>
        </div>

        <div className="reference-editor-panel__divider" aria-hidden="true" />

        <div className="reference-editor-panel__column reference-editor-panel__column--form">
          <div className="reference-form-heading">
            <h3>เพิ่มหรือเปลี่ยนรูปร้าน</h3>
          </div>
          {selectedShop ? (
            <form className="reference-form" onSubmit={saveShopImage}>
              <div className="reference-shop-preview">
                {shopPreviewSrc ? (
                  <img alt={selectedShop.name} className="reference-shop-preview__image" src={shopPreviewSrc} />
                ) : (
                  <div className="reference-shop-preview__placeholder">
                    <ImageSquare aria-hidden="true" size={42} />
                  </div>
                )}
                <div className="reference-shop-preview__meta">
                  <strong>{selectedShop.code} · {selectedShop.name}</strong>
                  <small>{selectedShop.image_path ? 'ร้านนี้มีรูปในระบบแล้ว' : 'ร้านนี้ยังไม่มีรูปในระบบ'}</small>
                  {shopUploadFile ? <small>ไฟล์ใหม่: {shopUploadFile.name}</small> : null}
                  {shopPreviewLoading && !shopUploadFile ? <small>กำลังโหลดรูปตัวอย่าง...</small> : null}
                </div>
              </div>

              <label className="secondary-button reference-upload-button">
                <UploadSimple size={18} />
                <span>{selectedShop.image_path ? 'เลือกรูปใหม่' : 'เลือกรูป'}</span>
                <input accept="image/jpeg,image/png,image/webp" onChange={chooseShopImageFile} type="file" />
              </label>

              <p className="reference-inline-note"><Info size={16} weight="fill" />รองรับ JPG, PNG, WEBP และขนาดไม่เกิน 5 MB</p>
              {shopImageError ? <p className="error-text" role="alert">{shopImageError}</p> : null}
              {shopImageSuccess ? <p aria-live="polite" className="success-text">{shopImageSuccess}</p> : null}

              <div className="reference-form__actions">
                {shopUploadFile ? (
                  <button className="secondary-button" onClick={() => setShopUploadFile(null)} type="button">
                    ยกเลิกรูปใหม่
                  </button>
                ) : null}
                <button
                  className="ghost-button"
                  disabled={savingShopImage || !selectedShop.image_path}
                  onClick={() => void removeShopImage()}
                  type="button"
                >
                  <Trash size={18} />
                  <span>ลบรูป</span>
                </button>
                <button className="primary-button" disabled={savingShopImage || !shopUploadFile} type="submit">
                  {savingShopImage ? 'กำลังบันทึก...' : 'บันทึกรูปร้าน'}
                </button>
              </div>
            </form>
          ) : <p className="empty-text">เลือกร้านจากรายการเพื่อเพิ่มหรือแก้ไขรูป</p>}
        </div>
      </div>
    </section>
  );
}
