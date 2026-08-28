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

        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int widthBytes = (width + 7) / 8;
        ByteArrayOutputStream output = new ByteArrayOutputStream(8 + widthBytes * height);
        output.write(rasterHeader(width, height));

        int[] pixels = new int[width];
        for (int y = 0; y < height; y++) {
            bitmap.getPixels(pixels, 0, width, 0, y, width, 1);
            output.write(packRow(pixels, width));
        }

        if (bitmap != source) bitmap.recycle();
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
