export const IMAGE_MAX_WIDTH = 1600;
export const IMAGE_MAX_HEIGHT = 1200;
export const IMAGE_TARGET_SIZE = 400 * 1024;
export const IMAGE_INITIAL_QUALITY = 82;
export const IMAGE_MIN_QUALITY = 75;

export function fitImageWithinBounds(width: number, height: number) {
  const scale = Math.min(1, IMAGE_MAX_WIDTH / width, IMAGE_MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function encodeCanvasAsWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('ไม่สามารถบีบอัดรูปภาพได้'));
    }, 'image/webp', quality / 100);
  });
}

export async function compressImageCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  let latestBlob: Blob | null = null;

  for (let quality = IMAGE_INITIAL_QUALITY; quality >= IMAGE_MIN_QUALITY; quality -= 1) {
    latestBlob = await encodeCanvasAsWebp(canvas, quality);
    if (latestBlob.size <= IMAGE_TARGET_SIZE) return latestBlob;
  }

  return latestBlob!;
}

export async function optimizeImage(file: File): Promise<File> {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพได้'));
      nextImage.src = objectUrl;
    });
    const { width, height } = fitImageWithinBounds(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('ไม่สามารถเตรียมรูปภาพสำหรับอัปโหลดได้');

    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const blob = await compressImageCanvas(canvas);
    const originalName = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${originalName}.webp`, { type: 'image/webp' });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
