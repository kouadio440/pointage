import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Tests unitaires de l'API : logique metier pure, sans base ni reseau.
 * Les tests d'integration (Testcontainers) et de securite ont leurs propres
 * configurations, car ils sont lents et ne doivent pas ralentir la boucle courte.
 */
export default defineConfig({
  plugins: [
    // SWC gere les decorateurs NestJS, qu'esbuild ne sait pas transpiler.
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/**/*.module.ts', 'src/**/*.test.ts'],
      // Le repertoire domain/ porte les regles qui produisent de l'argent et de
      // la discipline : geofence, fraude, retards, heures supplementaires, paie.
      thresholds: {
        'src/domain/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
