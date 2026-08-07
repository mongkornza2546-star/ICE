import { describe, expect, it, vi } from 'vitest';
import { withSignedImageUrls } from '../src/lib/signedImageUrls';

const items = [
  { id: 'one', image_path: 'ice/one.webp' },
  { id: 'two', image_path: 'ice/two.webp' },
  { id: 'none', image_path: null },
];

describe('withSignedImageUrls', () => {
  it('requests image paths and maps complete and partial signed results', async () => {
    const signImagePaths = vi.fn().mockResolvedValue({
      data: [{ path: 'ice/one.webp', signedUrl: 'https://example.test/one.webp' }],
      error: null,
    });

    const result = await withSignedImageUrls(items, signImagePaths);

    expect(signImagePaths).toHaveBeenCalledWith(['ice/one.webp', 'ice/two.webp']);
    expect(result).toEqual([
      { id: 'one', image_path: 'ice/one.webp', image_url: 'https://example.test/one.webp' },
      { id: 'two', image_path: 'ice/two.webp', image_url: null },
      { id: 'none', image_path: null, image_url: null },
    ]);
  });

  it('preserves the original items when signing fails', async () => {
    const signImagePaths = vi.fn().mockResolvedValue({ data: null, error: new Error('storage unavailable') });

    await expect(withSignedImageUrls(items, signImagePaths)).resolves.toBe(items);
  });

  it('skips storage when there are no image paths', async () => {
    const withoutImages = [{ id: 'none', image_path: null }];
    const signImagePaths = vi.fn();

    await expect(withSignedImageUrls(withoutImages, signImagePaths)).resolves.toBe(withoutImages);
    expect(signImagePaths).not.toHaveBeenCalled();
  });
});
