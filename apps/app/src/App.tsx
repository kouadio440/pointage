import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Panel } from './ui/Panel.js';

/**
 * Arborescence par role.
 *
 * Un espace par role plutot qu'un dashboard unique qui masque des blocs :
 * masquer suppose que tout le monde charge tout, et le moindre oubli de
 * condition expose des donnees. Ici, un employe ne charge meme pas le code
 * des ecrans RH.
 *
 * Les gardes de route arrivent en phase 1 avec l'authentification. Ils ne sont
 * qu'un confort : c'est l'API qui decide, toujours.
 */
const EspaceEmploye = lazy(() => import('./routes/employe/EspaceEmploye.js'));

function Chargement() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Panel className="p-8 text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-subtle border-t-gold" />
        <p className="mt-4 text-xs text-muted">Chargement de votre espace...</p>
      </Panel>
    </div>
  );
}

function Introuvable() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Panel accent="gold" className="max-w-md p-8 text-center">
        <p className="font-bold text-offwhite">Page introuvable</p>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Cette page n&apos;existe pas, ou ne fait pas partie de votre perimetre. Revenez a votre
          espace pour reprendre votre travail.
        </p>
        <a
          href="/app/moi"
          className="magnetic-btn mt-5 inline-block min-h-tap rounded-xl border border-subtle bg-subtle px-6 py-2.5 text-xs font-bold text-offwhite"
        >
          Retour a mon espace
        </a>
      </Panel>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter basename="/app">
      <Suspense fallback={<Chargement />}>
        <Routes>
          <Route path="/" element={<Navigate to="/moi" replace />} />
          <Route path="/moi/*" element={<EspaceEmploye />} />
          {/*
            Phase 1 : /equipe (manager), /rh, /direction (CEO), /plateforme
            (super admin), /login et /inscription.
          */}
          <Route path="*" element={<Introuvable />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
