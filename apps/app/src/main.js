import { jsx as _jsx } from "react/jsx-runtime";
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import './styles.css';
/**
 * Etat serveur : TanStack Query. Etat d'interface : Zustand (phase 1).
 * La distinction est stricte - dupliquer l'etat serveur dans un store global
 * est la premiere cause d'ecrans qui se contredisent entre eux.
 */
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            // Le reseau cible est souvent lent et intermittent : on evite les
            // rechargements agressifs qui consomment le forfait des utilisateurs.
            staleTime: 30_000,
            retry: 2,
            refetchOnWindowFocus: false,
        },
    },
});
const container = document.getElementById('root');
if (!container)
    throw new Error('Element #root introuvable dans index.html.');
createRoot(container).render(_jsx(StrictMode, { children: _jsx(QueryClientProvider, { client: queryClient, children: _jsx(App, {}) }) }));
//# sourceMappingURL=main.js.map