import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  return {
    base: mode === 'production' ? '/ccm/djs-broadcast/' : '/',
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts']
    }
  };
});
