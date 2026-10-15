import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.superice.delivery',
  appName: 'ส่งน้ำแข็ง',
  webDir: process.env.ICE_APP_TARGET === 'employee' ? 'dist-employee' : 'dist',
  android: {
    allowMixedContent: false,
  },
};

export default config;
