import react from '@vitejs/plugin-react';
// defineConfig vient de vitest/config, pas de vite : c'est ce qui autorise la
// cle `test` dans le meme fichier de configuration.
import { defineConfig } from 'vitest/config';
export default defineConfig({
    plugins: [react()],
    // L'application authentifiee est servie sous /app ; le site vitrine garde
    // la racine. C'est ce qui permet de ne pas toucher a apps/web.
    base: '/app/',
    server: {
        port: 5173,
        proxy: {
            // En developpement, l'API est appelee en relatif : aucun CORS a traverser,
            // et les cookies httpOnly du refresh token se comportent comme en production.
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
        rollupOptions: {
            output: {
                // Le reseau cible est souvent lent : on isole les gros vendors pour
                // qu'une mise a jour applicative n'invalide pas tout le cache.
                manualChunks: {
                    react: ['react', 'react-dom', 'react-router'],
                    query: ['@tanstack/react-query'],
                },
            },
        },
    },
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.test.{ts,tsx}'],
    },
});
//# sourceMappingURL=vite.config.js.map