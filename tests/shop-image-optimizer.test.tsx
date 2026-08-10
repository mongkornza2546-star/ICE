import { describe, expect, it } from 'vitest';
import {
  fitShopImageWithinBounds,
  SHOP_IMAGE_MAX_HEIGHT,
  SHOP_IMAGE_MAX_WIDTH,
} from '../src/features/admin-reference-settings/shopImageOptimizer';

describe('shop image optimizer dimensions', () => {
  it('keeps a high-resolution landscape image within 1600x1200', () => {
    expect(SHOP_IMAGE_MAX_WIDTH).toBe(1600);
    expect(SHOP_IMAGE_MAX_HEIGHT).toBe(1200);
    expect(fitShopImageWithinBounds(4032, 3024)).toEqual({ width: 1600, height: 1200 });
  });

  it('preserves portrait orientation at a useful resolution', () => {
    expect(fitShopImageWithinBounds(3024, 4032)).toEqual({ width: 900, height: 1200 });
  });

  it('does not enlarge a smaller source image', () => {
    expect(fitShopImageWithinBounds(800, 600)).toEqual({ width: 800, height: 600 });
  });
});
