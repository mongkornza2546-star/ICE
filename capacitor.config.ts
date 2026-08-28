import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.superice.delivery',
  appName: 'ส่งน้ำแข็ง',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
};

export default config;
