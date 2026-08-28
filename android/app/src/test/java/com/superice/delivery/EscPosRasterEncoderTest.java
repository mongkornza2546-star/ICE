package com.superice.delivery;

import static org.junit.Assert.assertArrayEquals;

import org.junit.Test;

public class EscPosRasterEncoderTest {
    @Test
    public void rasterHeaderUsesEscPosWidthBytesAndHeight() {
        assertArrayEquals(
            new byte[] { 0x1d, 0x76, 0x30, 0x00, 0x30, 0x00, 0x02, 0x01 },
            EscPosRasterEncoder.rasterHeader(384, 258)
        );
    }

    @Test
    public void rowPackingUsesThePrintThresholdAndIgnoresTransparentPixels() {
        int[] pixels = {
            0xff000000,
            0xffffffff,
            0xffb3b3b3,
            0xffb4b4b4,
            0x00000000,
            0xffffffff,
            0xffffffff,
            0xffffffff,
        };

        assertArrayEquals(new byte[] { (byte) 0xa0 }, EscPosRasterEncoder.packRow(pixels, pixels.length));
    }
}
