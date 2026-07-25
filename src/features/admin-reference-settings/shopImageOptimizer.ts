export const SHOP_IMAGE_MAX_WIDTH = 800;
export const SHOP_IMAGE_MAX_HEIGHT = 450;
const SHOP_IMAGE_WEBP_QUALITY = 0.8;

export function fitShopImageWithinBounds(width: number, height: number) {
  const scale = Math.min(1, SHOP_IMAGE_MAX_WIDTH / width, SHOP_IMAGE_MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function optimizeShopImage(file: File): Promise<File> {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพได้'));
      nextImage.src = objectUrl;
    });
    const { width, height } = fitShopImageWithinBounds(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('ไม่สามารถเตรียมรูปภาพสำหรับอัปโหลดได้');

    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('ไม่สามารถบีบอัดรูปภาพได้'));
      }, 'image/webp', SHOP_IMAGE_WEBP_QUALITY);
    });
    const originalName = file.name.replace(/\.[^.]+$/, '') || 'shop-image';
    return new File([blob], `${originalName}.webp`, { type: 'image/webp' });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
