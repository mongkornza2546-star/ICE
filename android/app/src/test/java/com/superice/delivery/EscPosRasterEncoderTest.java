package com.superice.delivery;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;

import org.junit.Test;

public class EscPosRasterEncoderTest {
    @Test
    public void bandsStartEarlyAndPreserveEveryRowIncludingTheFooter() throws Exception {
        int width = 384;
        int height = 803;
        ByteArrayOutputStream expected = new ByteArrayOutputStream();
        byte[] encoded = EscPosRasterEncoder.encodeRows(width, height, (y, pixels) -> {
            for (int x = 0; x < width; x++) pixels[x] = (x + y) % 7 == 0 ? 0xff000000 : 0xffffffff;
            byte[] row = EscPosRasterEncoder.packRow(pixels, width);
            expected.write(row, 0, row.length);
        });
        ByteArrayOutputStream actual = new ByteArrayOutputStream();
        int offset = 0;
        int rows = 0;
        while (offset < encoded.length) {
            int bandRows = (encoded[offset + 6] & 0xff) | ((encoded[offset + 7] & 0xff) << 8);
            assertTrue(bandRows > 0 && bandRows <= 24);
            assertArrayEquals(EscPosRasterEncoder.rasterHeader(width, bandRows), Arrays.copyOfRange(encoded, offset, offset + 8));
            int length = (width / 8) * bandRows;
            actual.write(encoded, offset + 8, length);
            offset += 8 + length;
            if (rows == 0) assertTrue("First printable command must not wait for the whole receipt", offset < 1600);
            rows += bandRows;
        }
        assertEquals(height, rows);
        assertEquals(encoded.length, offset);
        assertArrayEquals(expected.toByteArray(), actual.toByteArray());
    }

    @Test
    public void shortAndExactBandReceiptsDoNotLoseOrAddRows() throws Exception {
        for (int height : new int[] { 1, 23, 24, 25, 48, 8192 }) {
            byte[] encoded = EscPosRasterEncoder.encodeRows(9, height, (y, pixels) -> Arrays.fill(pixels, 0xff000000));
            int offset = 0;
            int rows = 0;
            while (offset < encoded.length) {
                int count = (encoded[offset + 6] & 0xff) | ((encoded[offset + 7] & 0xff) << 8);
                for (int y = 0; y < count; y++) {
                    assertEquals(255, encoded[offset + 8 + y * 2] & 0xff);
                    assertEquals(128, encoded[offset + 9 + y * 2] & 0xff);
                }
                rows += count;
                offset += 8 + count * 2;
            }
            assertEquals(height, rows);
            assertEquals(encoded.length, offset);
        }
    }

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
