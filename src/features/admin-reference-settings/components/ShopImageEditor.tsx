import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { Info, ImageSquare, Trash, UploadSimple } from '@phosphor-icons/react';
import { ALLOWED_SHOP_IMAGE_TYPES, MAX_SHOP_IMAGE_SIZE, type ShopImageSetting } from '../types';
import {
  getErrorMessage,
  getShopImageSignedUrl,
  uploadShopImage,
  updateShopImagePath,
  removeShopImageFiles,
} from '../adminReferenceSettingsService';

interface ShopImageEditorProps {
  shop: ShopImageSetting | null;
  onShopSaved: (savedShop: ShopImageSetting) => void;
}

export function ShopImageEditor({ shop, onShopSaved }: ShopImageEditorProps) {
  const [shopPreviewUrl, setShopPreviewUrl] = useState<string | null>(null);
  const [shopPreviewLoading, setShopPreviewLoading] = useState(false);
  const [shopUploadFile, setShopUploadFile] = useState<File | null>(null);
  const [shopUploadPreviewUrl, setShopUploadPreviewUrl] = useState<string | null>(null);
  const [savingShopImage, setSavingShopImage] = useState(false);
  const [shopImageError, setShopImageError] = useState<string | null>(null);
  const [shopImageSuccess, setShopImageSuccess] = useState<string | null>(null);

  const shopPreviewSrc = shopUploadPreviewUrl ?? shopPreviewUrl;

  useEffect(() => {
    setShopUploadFile(null);
    setShopImageError(null);
    setShopImageSuccess(null);
  }, [shop?.id]);

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
    const imagePath = shop?.image_path;

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
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setShopPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [shop?.image_path, shopUploadFile]);

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
    if (!shop || !shopUploadFile) {
      setShopImageError('กรุณาเลือกรูปร้านก่อนบันทึก');
      return;
    }

    setSavingShopImage(true);
    setShopImageError(null);
    setShopImageSuccess(null);
    const previousPath = shop.image_path;

    try {
      const nextPath = await uploadShopImage(shop.id, shopUploadFile);
      try {
        const savedShop = await updateShopImagePath(shop.id, nextPath);
        if (previousPath && previousPath !== nextPath) {
          await removeShopImageFiles([previousPath]).catch(() => {});
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
    if (!shop?.image_path) {
      setShopImageError('ร้านนี้ยังไม่มีรูปในระบบ');
      return;
    }

    setSavingShopImage(true);
    setShopImageError(null);
    setShopImageSuccess(null);
    const previousPath = shop.image_path;

    try {
      const savedShop = await updateShopImagePath(shop.id, null);
      let removeError = false;
      try {
        await removeShopImageFiles([previousPath]);
      } catch {
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

  return (
    <div className="shop-image-editor">
      <div className="reference-form-heading"><h3>รูปร้าน</h3></div>
      {shop ? (
        <form className="reference-form" onSubmit={saveShopImage}>
          <div className="reference-shop-preview">
            {shopPreviewSrc ? <img alt={shop.name} className="reference-shop-preview__image" src={shopPreviewSrc} /> : (
              <div className="reference-shop-preview__placeholder"><ImageSquare aria-hidden="true" size={42} /></div>
            )}
            <div className="reference-shop-preview__meta">
              <strong>{shop.code} · {shop.name}</strong>
              <small>{shop.image_path ? 'ร้านนี้มีรูปในระบบแล้ว' : 'ร้านนี้ยังไม่มีรูปในระบบ'}</small>
              {shopUploadFile ? <small>ไฟล์ใหม่: {shopUploadFile.name}</small> : null}
              {shopPreviewLoading && !shopUploadFile ? <small>กำลังโหลดรูปตัวอย่าง...</small> : null}
            </div>
          </div>
          <label className="secondary-button reference-upload-button">
            <UploadSimple size={18} />
            <span>{shop.image_path ? 'เลือกรูปใหม่' : 'เลือกรูป'}</span>
            <input accept="image/jpeg,image/png,image/webp" onChange={chooseShopImageFile} type="file" />
          </label>
          <p className="reference-inline-note"><Info size={16} weight="fill" />รองรับ JPG, PNG, WEBP และขนาดไม่เกิน 5 MB</p>
          {shopImageError ? <p className="error-text" role="alert">{shopImageError}</p> : null}
          {shopImageSuccess ? <p aria-live="polite" className="success-text">{shopImageSuccess}</p> : null}
          <div className="reference-form__actions">
            {shopUploadFile ? <button className="secondary-button" onClick={() => setShopUploadFile(null)} type="button">ยกเลิกรูปใหม่</button> : null}
            <button className="ghost-button" disabled={savingShopImage || !shop.image_path} onClick={() => void removeShopImage()} type="button"><Trash size={18} /><span>ลบรูป</span></button>
            <button className="primary-button" disabled={savingShopImage || !shopUploadFile} type="submit">{savingShopImage ? 'กำลังบันทึก...' : 'บันทึกรูปร้าน'}</button>
          </div>
        </form>
      ) : <p className="muted">บันทึกข้อมูลร้านก่อน แล้วจึงเพิ่มหรือเปลี่ยนรูปร้านได้</p>}
    </div>
  );
}
