import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
    return (_jsx("div", { className: "flex min-h-screen items-center justify-center p-6", children: _jsxs(Panel, { className: "p-8 text-center", children: [_jsx("div", { className: "mx-auto h-8 w-8 animate-spin rounded-full border-2 border-subtle border-t-gold" }), _jsx("p", { className: "mt-4 text-xs text-muted", children: "Chargement de votre espace..." })] }) }));
}
function Introuvable() {
    return (_jsx("div", { className: "flex min-h-screen items-center justify-center p-6", children: _jsxs(Panel, { accent: "gold", className: "max-w-md p-8 text-center", children: [_jsx("p", { className: "font-bold text-offwhite", children: "Page introuvable" }), _jsx("p", { className: "mt-2 text-xs leading-relaxed text-muted", children: "Cette page n'existe pas, ou ne fait pas partie de votre perimetre. Revenez a votre espace pour reprendre votre travail." }), _jsx("a", { href: "/app/moi", className: "magnetic-btn mt-5 inline-block min-h-tap rounded-xl border border-subtle bg-subtle px-6 py-2.5 text-xs font-bold text-offwhite", children: "Retour a mon espace" })] }) }));
}
export function App() {
    return (_jsx(BrowserRouter, { basename: "/app", children: _jsx(Suspense, { fallback: _jsx(Chargement, {}), children: _jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(Navigate, { to: "/moi", replace: true }) }), _jsx(Route, { path: "/moi/*", element: _jsx(EspaceEmploye, {}) }), _jsx(Route, { path: "*", element: _jsx(Introuvable, {}) })] }) }) }));
}
//# sourceMappingURL=App.js.map