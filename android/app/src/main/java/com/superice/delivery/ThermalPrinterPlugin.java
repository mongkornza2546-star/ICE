package com.superice.delivery;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "ThermalPrinter",
    permissions = {
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class ThermalPrinterPlugin extends Plugin {
    private static final UUID SERIAL_PORT_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final int PRINT_WIDTH_DOTS = 384;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void ensurePermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || hasBluetoothPermission()) {
            resolvePermission(call, true);
            return;
        }
        requestPermissionForAlias("bluetooth", call, "bluetoothPermissionCallback");
    }

    @PermissionCallback
    private void bluetoothPermissionCallback(PluginCall call) {
        resolvePermission(call, hasBluetoothPermission());
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        BluetoothAdapter adapter = getBluetoothAdapter();
        JSObject result = new JSObject();
        result.put("supported", adapter != null);
        result.put("enabled", adapter != null && adapter.isEnabled());
        call.resolve(result);
    }

    @PluginMethod
    public void getPairedDevices(PluginCall call) {
        if (!hasBluetoothPermission()) {
            call.reject("กรุณาอนุญาตให้แอปเชื่อมต่ออุปกรณ์ใกล้เคียง", "PERMISSION_REQUIRED");
            return;
        }
        BluetoothAdapter adapter = getBluetoothAdapter();
        if (adapter == null) {
            call.reject("โทรศัพท์เครื่องนี้ไม่รองรับ Bluetooth", "BLUETOOTH_UNSUPPORTED");
            return;
        }
        if (!adapter.isEnabled()) {
            call.reject("กรุณาเปิด Bluetooth ก่อน", "BLUETOOTH_DISABLED");
            return;
        }

        try {
            Set<BluetoothDevice> bondedDevices = adapter.getBondedDevices();
            List<BluetoothDevice> devices = new ArrayList<>(bondedDevices);
            devices.sort(Comparator.comparing(device -> safeName(device).toLowerCase()));
            JSArray result = new JSArray();
            for (BluetoothDevice device : devices) {
                JSObject item = new JSObject();
                item.put("name", safeName(device));
                item.put("address", device.getAddress());
                result.put(item);
            }
            JSObject response = new JSObject();
            response.put("devices", result);
            call.resolve(response);
        } catch (SecurityException exception) {
            call.reject("ไม่มีสิทธิ์อ่านรายชื่ออุปกรณ์ Bluetooth", "PERMISSION_REQUIRED", exception);
        }
    }

    @PluginMethod
    public void openBluetoothSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
        getActivity().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void printImage(PluginCall call) {
        if (!hasBluetoothPermission()) {
            call.reject("กรุณาอนุญาตให้แอปเชื่อมต่ออุปกรณ์ใกล้เคียง", "PERMISSION_REQUIRED");
            return;
        }
        String address = call.getString("address");
        String imageBase64 = call.getString("imageBase64");
        if (address == null || address.trim().isEmpty() || imageBase64 == null || imageBase64.trim().isEmpty()) {
            call.reject("ข้อมูลเครื่องพิมพ์หรือภาพใบเสร็จไม่ครบ", "INVALID_ARGUMENT");
            return;
        }

        executor.execute(() -> printImageInBackground(call, address, imageBase64));
    }

    private void printImageInBackground(PluginCall call, String address, String imageBase64) {
        BluetoothSocket socket = null;
        try {
            BluetoothAdapter adapter = getBluetoothAdapter();
            if (adapter == null || !adapter.isEnabled()) {
                call.reject("กรุณาเปิด Bluetooth ก่อน", "BLUETOOTH_DISABLED");
                return;
            }
            BluetoothDevice device = adapter.getRemoteDevice(address);
            byte[] imageBytes = Base64.decode(stripDataUrlPrefix(imageBase64), Base64.DEFAULT);
            Bitmap bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.length);
            if (bitmap == null) {
                call.reject("ไม่สามารถอ่านภาพใบเสร็จได้", "INVALID_IMAGE");
                return;
            }
            socket = device.createRfcommSocketToServiceRecord(SERIAL_PORT_UUID);
            socket.connect();
            OutputStream output = socket.getOutputStream();
            output.write(new byte[] { 0x1b, 0x40 });
            output.write(EscPosRasterEncoder.toEscPosRaster(bitmap, PRINT_WIDTH_DOTS));
            output.write(new byte[] { 0x0a, 0x0a, 0x0a });
            output.flush();
            bitmap.recycle();

            JSObject result = new JSObject();
            result.put("printed", true);
            call.resolve(result);
        } catch (IllegalArgumentException exception) {
            call.reject("ที่อยู่ Bluetooth หรือข้อมูลภาพไม่ถูกต้อง", "INVALID_ARGUMENT", exception);
        } catch (SecurityException exception) {
            call.reject("ไม่มีสิทธิ์เชื่อมต่อ Bluetooth", "PERMISSION_REQUIRED", exception);
        } catch (IOException exception) {
            call.reject("เชื่อมต่อเครื่องพิมพ์ไม่สำเร็จ กรุณาตรวจว่าเปิดเครื่องและจับคู่แล้ว", "CONNECTION_FAILED", exception);
        } finally {
            if (socket != null) {
                try {
                    socket.close();
                } catch (IOException ignored) {
                    // The print attempt has already completed or failed.
                }
            }
        }
    }

    private BluetoothAdapter getBluetoothAdapter() {
        BluetoothManager manager = getContext().getSystemService(BluetoothManager.class);
        return manager == null ? null : manager.getAdapter();
    }

    private boolean hasBluetoothPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || getPermissionState("bluetooth") == PermissionState.GRANTED;
    }

    private void resolvePermission(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    private String safeName(BluetoothDevice device) {
        String name = device.getName();
        return name == null || name.trim().isEmpty() ? "Bluetooth device" : name;
    }

    private String stripDataUrlPrefix(String value) {
        int comma = value.indexOf(',');
        return value.startsWith("data:") && comma >= 0 ? value.substring(comma + 1) : value;
    }

}
