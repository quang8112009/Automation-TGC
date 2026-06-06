import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Test-only configuration. This does NOT add any UI/CSS framework; it wires the
// Vitest runner against a jsdom DOM so component tests (@testing-library/react)
// and pure-logic property tests (fast-check) can run. Production styling stays
// entirely in src/styles.css.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
