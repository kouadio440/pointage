import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.test.ts'],
      // Ce package porte les regles qui produisent de l'argent et de la
      // discipline (geofence, fraude, retards, FCFA). Le plancher y est eleve.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
