import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'virtual:pwa-register': fileURLToPath(new URL('./tests/mocks/pwa-register.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.tsx'],
    setupFiles: ['./tests/vitest.setup.ts'],
  },
});
