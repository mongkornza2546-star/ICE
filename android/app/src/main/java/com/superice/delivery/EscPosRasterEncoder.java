package com.superice.delivery;

import android.graphics.Bitmap;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

final class EscPosRasterEncoder {
    private EscPosRasterEncoder() {}

    static byte[] toEscPosRaster(Bitmap source, int targetWidth) throws IOException {
        Bitmap bitmap = source;
        if (source.getWidth() != targetWidth) {
            int scaledHeight = Math.max(1, Math.round(source.getHeight() * (targetWidth / (float) source.getWidth())));
            bitmap = Bitmap.createScaledBitmap(source, targetWidth, scaledHeight, true);
        }

        try {
            Bitmap raster = bitmap;
            return encodeRows(raster.getWidth(), raster.getHeight(), (y, pixels) ->
                raster.getPixels(pixels, 0, pixels.length, 0, y, pixels.length, 1));
        } finally {
            if (bitmap != source) bitmap.recycle();
        }
    }

    interface PixelRowReader {
        void read(int y, int[] pixels);
    }

    static byte[] encodeRows(int width, int height, PixelRowReader reader) throws IOException {
        // Small complete raster commands let portable printers start before the
        // whole receipt arrives and avoid their per-image height/buffer limits.
        final int bandHeight = 24;
        int widthBytes = (width + 7) / 8;
        ByteArrayOutputStream output = new ByteArrayOutputStream(widthBytes * height + 8 * ((height + bandHeight - 1) / bandHeight));
        int[] pixels = new int[width];
        for (int startY = 0; startY < height; startY += bandHeight) {
            int rows = Math.min(bandHeight, height - startY);
            output.write(rasterHeader(width, rows));
            for (int y = startY; y < startY + rows; y++) {
                reader.read(y, pixels);
                output.write(packRow(pixels, width));
            }
        }
        return output.toByteArray();
    }

    static byte[] rasterHeader(int width, int height) {
        int widthBytes = (width + 7) / 8;
        return new byte[] {
            0x1d, 0x76, 0x30, 0x00,
            (byte) (widthBytes & 0xff), (byte) ((widthBytes >> 8) & 0xff),
            (byte) (height & 0xff), (byte) ((height >> 8) & 0xff)
        };
    }

    static byte[] packRow(int[] pixels, int width) {
        int widthBytes = (width + 7) / 8;
        byte[] result = new byte[widthBytes];
        for (int byteIndex = 0; byteIndex < widthBytes; byteIndex++) {
            int packed = 0;
            for (int bit = 0; bit < 8; bit++) {
                int x = byteIndex * 8 + bit;
                if (x >= width) continue;
                int color = pixels[x];
                int alpha = (color >>> 24) & 0xff;
                int red = (color >>> 16) & 0xff;
                int green = (color >>> 8) & 0xff;
                int blue = color & 0xff;
                int luminance = (red * 299 + green * 587 + blue * 114) / 1000;
                if (alpha >= 64 && luminance < 180) packed |= 1 << (7 - bit);
            }
            result[byteIndex] = (byte) packed;
        }
        return result;
    }
}
