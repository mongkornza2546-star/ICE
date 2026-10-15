var config = {
    appId: 'com.superice.delivery',
    appName: 'ส่งน้ำแข็ง',
    webDir: process.env.ICE_APP_TARGET === 'employee' ? 'dist-employee' : 'dist',
    android: {
        allowMixedContent: false,
    },
};
export default config;
