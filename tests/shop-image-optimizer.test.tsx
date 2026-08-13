import { describe, expect, it } from 'vitest';
import {
  compressImageCanvas,
  fitImageWithinBounds,
  IMAGE_INITIAL_QUALITY,
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_MIN_QUALITY,
  IMAGE_TARGET_SIZE,
} from '../src/lib/imageOptimizer';

describe('shop image optimizer dimensions', () => {
  it('keeps a high-resolution landscape image within 1600x1200', () => {
    expect(IMAGE_MAX_WIDTH).toBe(1600);
    expect(IMAGE_MAX_HEIGHT).toBe(1200);
    expect(fitImageWithinBounds(4032, 3024)).toEqual({ width: 1600, height: 1200 });
  });

  it('preserves portrait orientation at a useful resolution', () => {
    expect(fitImageWithinBounds(3024, 4032)).toEqual({ width: 900, height: 1200 });
  });

  it('does not enlarge a smaller source image', () => {
    expect(fitImageWithinBounds(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe('shop image optimizer compression', () => {
  it('starts at 82% and stops at the first result within 400 KB', async () => {
    const qualities: number[] = [];
    const canvas = {
      toBlob(callback: BlobCallback, type: string, quality: number) {
        qualities.push(quality);
        const size = quality > 0.8 ? IMAGE_TARGET_SIZE + 1 : IMAGE_TARGET_SIZE;
        callback(new Blob([new Uint8Array(size)], { type }));
      },
    } as HTMLCanvasElement;

    const result = await compressImageCanvas(canvas);

    expect(IMAGE_INITIAL_QUALITY).toBe(82);
    expect(IMAGE_TARGET_SIZE).toBe(400 * 1024);
    expect(qualities).toEqual([0.82, 0.81, 0.8]);
    expect(result.size).toBe(IMAGE_TARGET_SIZE);
    expect(result.type).toBe('image/webp');
  });

  it('keeps the 75% result when the target size cannot be reached', async () => {
    const qualities: number[] = [];
    const canvas = {
      toBlob(callback: BlobCallback, type: string, quality: number) {
        qualities.push(quality);
        callback(new Blob([new Uint8Array(IMAGE_TARGET_SIZE + 1)], { type }));
      },
    } as HTMLCanvasElement;

    const result = await compressImageCanvas(canvas);

    expect(IMAGE_MIN_QUALITY).toBe(75);
    expect(qualities).toEqual([0.82, 0.81, 0.8, 0.79, 0.78, 0.77, 0.76, 0.75]);
    expect(result.size).toBe(IMAGE_TARGET_SIZE + 1);
  });
});
