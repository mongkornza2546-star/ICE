import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { ImageSquare, Trash, UploadSimple } from '@phosphor-icons/react';
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
    <div className="ref-section">
      <div className="ref-section-title">
        <h3>รูปสินค้า</h3>
      </div>
      {iceType ? (
        <form className="ref-image-editor-body" onSubmit={saveIceTypeImage}>
          <div className="ref-image-preview-card" style={{ maxWidth: '300px' }}>
            <div className="ref-image-preview-box">
              {iceTypePreviewSrc ? (
                <img alt={iceType.name} src={iceTypePreviewSrc} />
              ) : (
                <div className="ref-image-placeholder">
                  <ImageSquare size={36} />
                </div>
              )}
            </div>
            <div className="ref-image-meta">
              <span className="ref-image-filename">
                {iceTypeUploadFile ? iceTypeUploadFile.name : (iceType.image_path ? `${iceType.code.toLowerCase()}-${iceType.name.toLowerCase().replace(/\s+/g, '-')}.jpg` : 'ไม่มีรูปในระบบ')}
              </span>
              {iceTypeUploadFile ? (
                <span className="ref-image-filesize">{(iceTypeUploadFile.size / 1024).toFixed(0)} KB</span>
              ) : iceTypePreviewLoading ? (
                <span className="ref-image-filesize">กำลังโหลด...</span>
              ) : null}
            </div>

            <div className="ref-image-preview-actions">
              <label className="secondary-button ref-upload-btn">
                <UploadSimple size={16} />
                <span>{iceType.image_path || iceTypeUploadFile ? 'อัปโหลดใหม่' : 'อัปโหลดรูป'}</span>
                <input accept="image/jpeg,image/png,image/webp" onChange={chooseIceTypeImageFile} type="file" />
              </label>
              <button
                className="ref-trash-btn"
                disabled={savingIceTypeImage || (!iceType.image_path && !iceTypeUploadFile)}
                onClick={() => {
                  if (iceTypeUploadFile) {
                    setIceTypeUploadFile(null);
                  } else {
                    void removeIceTypeImage();
                  }
                }}
                title="ลบรูป"
                type="button"
              >
                <Trash size={16} />
              </button>
            </div>
          </div>

          {iceTypeImageError ? <p className="error-text" role="alert">{iceTypeImageError}</p> : null}
          {iceTypeImageSuccess ? <p aria-live="polite" className="success-text">{iceTypeImageSuccess}</p> : null}
          {iceTypeUploadFile ? (
            <div className="ref-image-submit-row">
              <button className="primary-button" disabled={savingIceTypeImage} type="submit">
                {savingIceTypeImage ? 'กำลังบันทึก...' : 'บันทึกรูปสินค้าใหม่'}
              </button>
            </div>
          ) : null}
        </form>
      ) : (
        /* New mode */
        <div className="ref-image-editor-body">
          <div className="ref-image-preview-card" style={{ maxWidth: '300px' }}>
            <div className="ref-image-preview-box">
              {pendingPreviewUrl ? (
                <img alt="ตัวอย่างรูปสินค้า" src={pendingPreviewUrl} />
              ) : (
                <div className="ref-image-placeholder">
                  <ImageSquare size={36} />
                </div>
              )}
            </div>
            <div className="ref-image-meta">
              <span className="ref-image-filename">
                {pendingFile ? pendingFile.name : 'ยังไม่เลือกรูป'}
              </span>
            </div>
            <div className="ref-image-preview-actions">
              <label className="secondary-button ref-upload-btn" style={{ flex: 1 }}>
                <UploadSimple size={16} />
                <span>{pendingFile ? 'อัปโหลดใหม่' : 'อัปโหลดรูป'}</span>
                <input accept="image/jpeg,image/png,image/webp" onChange={chooseIceTypeImageFile} type="file" />
              </label>
            </div>
          </div>
          {iceTypeImageError ? <p className="error-text" role="alert">{iceTypeImageError}</p> : null}
        </div>
      )}
    </div>
  );
}
