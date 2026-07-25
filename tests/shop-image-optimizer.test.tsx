import { describe, expect, it } from 'vitest';
import { fitShopImageWithinBounds } from '../src/features/admin-reference-settings/shopImageOptimizer';

describe('shop image optimization', () => {
  it('bounds landscape, portrait, and already-small images without distorting them', () => {
    expect(fitShopImageWithinBounds(4000, 3000)).toEqual({ width: 600, height: 450 });
    expect(fitShopImageWithinBounds(3000, 4000)).toEqual({ width: 338, height: 450 });
    expect(fitShopImageWithinBounds(640, 360)).toEqual({ width: 640, height: 360 });
  });
});
