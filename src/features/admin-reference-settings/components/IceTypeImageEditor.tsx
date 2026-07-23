import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { Info, ImageSquare, Trash, UploadSimple } from '@phosphor-icons/react';
import { ALLOWED_ICE_TYPE_IMAGE_TYPES, MAX_ICE_TYPE_IMAGE_SIZE, type IceTypeSetting } from '../types';
import {
  getErrorMessage,
  getIceTypeImageSignedUrl,
  uploadIceTypeImage,
  updateIceTypeImagePath,
  removeIceTypeImageFiles,
} from '../adminReferenceSettingsService';

interface IceTypeImageEditorProps {
  iceType: IceTypeSetting | null;
  onIceTypeSaved: (savedIceType: IceTypeSetting) => void;
  /** เรียกเมื่ออยู่ในโหมดสร้างใหม่ (iceType === null) และผู้ใช้เลือก/ยกเลิกรูปล่วงหน้า */
  onPendingFileChange?: (file: File | null) => void;
  /** ไฟล์รูปที่ parent ส่งมาควบคุม (ใช้ในโหมดสร้างใหม่) */
  pendingFile?: File | null;
}

export function IceTypeImageEditor({ iceType, onIceTypeSaved, onPendingFileChange, pendingFile }: IceTypeImageEditorProps) {
  const [iceTypePreviewUrl, setIceTypePreviewUrl] = useState<string | null>(null);
  const [iceTypePreviewLoading, setIceTypePreviewLoading] = useState(false);
  const [iceTypeUploadFile, setIceTypeUploadFile] = useState<File | null>(null);
  const [iceTypeUploadPreviewUrl, setIceTypeUploadPreviewUrl] = useState<string | null>(null);
  const [savingIceTypeImage, setSavingIceTypeImage] = useState(false);
  const [iceTypeImageError, setIceTypeImageError] = useState<string | null>(null);
  const [iceTypeImageSuccess, setIceTypeImageSuccess] = useState<string | null>(null);

  const iceTypePreviewSrc = iceTypeUploadPreviewUrl ?? iceTypePreviewUrl;

  useEffect(() => {
    setIceTypeUploadFile(null);
    setIceTypeImageError(null);
    setIceTypeImageSuccess(null);
  }, [iceType?.id]);

  useEffect(() => {
    if (!iceTypeUploadFile) {
      setIceTypeUploadPreviewUrl(null);
      return undefined;
    }

    const objectUrl = URL.createObjectURL(iceTypeUploadFile);
    setIceTypeUploadPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [iceTypeUploadFile]);

  useEffect(() => {
    let cancelled = false;
    const imagePath = iceType?.image_path;

    if (iceTypeUploadFile || !imagePath) {
      setIceTypePreviewLoading(false);
      setIceTypePreviewUrl(null);
      return undefined;
    }

    setIceTypePreviewLoading(true);
    setIceTypePreviewUrl(null);
    getIceTypeImageSignedUrl(imagePath)
      .then((url) => {
        if (!cancelled) setIceTypePreviewUrl(url);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIceTypePreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [iceType?.image_path, iceTypeUploadFile]);

  function chooseIceTypeImageFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (file.size > MAX_ICE_TYPE_IMAGE_SIZE) {
      if (onPendingFileChange) onPendingFileChange(null);
      setIceTypeUploadFile(null);
      setIceTypeImageSuccess(null);
      setIceTypeImageError('รูปต้องมีขนาดไม่เกิน 5 MB');
      return;
    }

    if (file.type && !ALLOWED_ICE_TYPE_IMAGE_TYPES.has(file.type)) {
      if (onPendingFileChange) onPendingFileChange(null);
      setIceTypeUploadFile(null);
      setIceTypeImageSuccess(null);
      setIceTypeImageError('รองรับเฉพาะไฟล์ JPG, PNG หรือ WEBP');
      return;
    }

    if (onPendingFileChange) {
      // โหมดสร้างใหม่: ส่งไฟล์กลับ parent แทน
      onPendingFileChange(file);
      setIceTypeImageError(null);
      setIceTypeImageSuccess(null);
      return;
    }

    setIceTypeUploadFile(file);
    setIceTypeImageError(null);
    setIceTypeImageSuccess(null);
  }

  async function saveIceTypeImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!iceType || !iceTypeUploadFile) {
      setIceTypeImageError('กรุณาเลือกรูปสินค้าก่อนบันทึก');
      return;
    }

    setSavingIceTypeImage(true);
    setIceTypeImageError(null);
    setIceTypeImageSuccess(null);
    const previousPath = iceType.image_path;

    try {
      const nextPath = await uploadIceTypeImage(iceType.id, iceTypeUploadFile);
      try {
        const savedIceType = await updateIceTypeImagePath(iceType.id, nextPath);
        let removeError = false;
        if (previousPath && previousPath !== nextPath) {
          try {
            await removeIceTypeImageFiles([previousPath]);
          } catch {
            removeError = true;
          }
        }
        onIceTypeSaved(savedIceType);
        setIceTypeUploadFile(null);
        setIceTypeImageSuccess(
          removeError
            ? 'อัปเดตรูปสินค้าแล้ว แต่ลบไฟล์เก่าไม่สำเร็จ'
            : previousPath ? 'อัปเดตรูปสินค้าแล้ว' : 'เพิ่มรูปสินค้าแล้ว',
        );
      } catch (updateError) {
        await removeIceTypeImageFiles([nextPath]).catch(() => {});
        throw updateError;
      }
    } catch (error) {
      setIceTypeImageError(getErrorMessage(error));
    } finally {
      setSavingIceTypeImage(false);
    }
  }

  async function removeIceTypeImage() {
    if (!iceType?.image_path) {
      setIceTypeImageError('ชนิดน้ำแข็งนี้ยังไม่มีรูปในระบบ');
      return;
    }

    setSavingIceTypeImage(true);
    setIceTypeImageError(null);
    setIceTypeImageSuccess(null);
    const previousPath = iceType.image_path;

    try {
      const savedIceType = await updateIceTypeImagePath(iceType.id, null);
      let removeError = false;
      try {
        await removeIceTypeImageFiles([previousPath]);
      } catch {
        removeError = true;
      }
      onIceTypeSaved(savedIceType);
      setIceTypeUploadFile(null);
      setIceTypeImageSuccess(removeError ? 'ลบการอ้างอิงรูปแล้ว แต่ลบไฟล์เก่าไม่สำเร็จ' : 'ลบรูปสินค้าแล้ว');
    } catch (error) {
      setIceTypeImageError(getErrorMessage(error));
    } finally {
      setSavingIceTypeImage(false);
    }
  }

  // Preview URL สำหรับโหมดสร้างใหม่ (ควบคุมโดย parent)
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingFile) {
      setPendingPreviewUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(pendingFile);
    setPendingPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  return (
    <div className="iceType-image-editor">
      <div className="reference-form-heading"><h3>รูปสินค้า</h3></div>
      {iceType ? (
        <form className="reference-form" onSubmit={saveIceTypeImage}>
          <div className="reference-iceType-preview">
            {iceTypePreviewSrc ? <img alt={iceType.name} className="reference-iceType-preview__image" src={iceTypePreviewSrc} /> : (
              <div className="reference-iceType-preview__placeholder"><ImageSquare aria-hidden="true" size={42} /></div>
            )}
            <div className="reference-iceType-preview__meta">
              <strong>{iceType.code} · {iceType.name}</strong>
              <small>{iceType.image_path ? 'ชนิดน้ำแข็งนี้มีรูปในระบบแล้ว' : 'ชนิดน้ำแข็งนี้ยังไม่มีรูปในระบบ'}</small>
              {iceTypeUploadFile ? <small>ไฟล์ใหม่: {iceTypeUploadFile.name}</small> : null}
              {iceTypePreviewLoading && !iceTypeUploadFile ? <small>กำลังโหลดรูปตัวอย่าง...</small> : null}
            </div>
          </div>
          <label className="secondary-button reference-upload-button">
            <UploadSimple size={18} />
            <span>{iceType.image_path ? 'เลือกรูปใหม่' : 'เลือกรูป'}</span>
            <input accept="image/jpeg,image/png,image/webp" onChange={chooseIceTypeImageFile} type="file" />
          </label>
          <p className="reference-inline-note"><Info size={16} weight="fill" />รองรับ JPG, PNG, WEBP และขนาดไม่เกิน 5 MB</p>
          {iceTypeImageError ? <p className="error-text" role="alert">{iceTypeImageError}</p> : null}
          {iceTypeImageSuccess ? <p aria-live="polite" className="success-text">{iceTypeImageSuccess}</p> : null}
          <div className="reference-form__actions">
            {iceTypeUploadFile ? <button className="secondary-button" onClick={() => setIceTypeUploadFile(null)} type="button">ยกเลิกรูปใหม่</button> : null}
            <button className="ghost-button" disabled={savingIceTypeImage || !iceType.image_path} onClick={() => void removeIceTypeImage()} type="button"><Trash size={18} /><span>ลบรูป</span></button>
            <button className="primary-button" disabled={savingIceTypeImage || !iceTypeUploadFile} type="submit">{savingIceTypeImage ? 'กำลังบันทึก...' : 'บันทึกรูปสินค้า'}</button>
          </div>
        </form>
      ) : (
        /* โหมดสร้างใหม่: เลือกรูปล่วงหน้าได้ รูปจะอัปโหลดพร้อมกับบันทึกชนิดน้ำแข็ง */
        <div className="reference-form">
          <div className="reference-iceType-preview">
            {pendingPreviewUrl ? (
              <img alt="ตัวอย่างรูปสินค้า" className="reference-iceType-preview__image" src={pendingPreviewUrl} />
            ) : (
              <div className="reference-iceType-preview__placeholder"><ImageSquare aria-hidden="true" size={42} /></div>
            )}
            <div className="reference-iceType-preview__meta">
              {pendingFile ? (
                <>
                  <strong>ไฟล์ที่เลือก</strong>
                  <small>{pendingFile.name}</small>
                  <small>รูปจะถูกอัปโหลดพร้อมกับการบันทึกชนิดน้ำแข็ง</small>
                </>
              ) : (
                <>
                  <strong>ยังไม่มีรูป</strong>
                  <small>เลือกรูปได้เลย จะอัปโหลดพร้อมกับการบันทึก</small>
                </>
              )}
            </div>
          </div>
          <label className="secondary-button reference-upload-button">
            <UploadSimple size={18} />
            <span>{pendingFile ? 'เปลี่ยนรูป' : 'เลือกรูป'}</span>
            <input accept="image/jpeg,image/png,image/webp" onChange={chooseIceTypeImageFile} type="file" />
          </label>
          <p className="reference-inline-note"><Info size={16} weight="fill" />รองรับ JPG, PNG, WEBP และขนาดไม่เกิน 5 MB</p>
          {iceTypeImageError ? <p className="error-text" role="alert">{iceTypeImageError}</p> : null}
          {pendingFile ? (
            <div className="reference-form__actions">
              <button
                className="secondary-button"
                onClick={() => { if (onPendingFileChange) onPendingFileChange(null); setIceTypeImageError(null); }}
                type="button"
              >
                ยกเลิกรูป
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
