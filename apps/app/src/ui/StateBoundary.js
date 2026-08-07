import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Panel } from './Panel.js';
export const MIN_EMPTY_BODY_LENGTH = 40;
/**
 * Ordre de priorite d'affichage : hors ligne > erreur > chargement > vide > contenu.
 *
 * Cet ordre compte. Afficher « aucune donnee » a quelqu'un qui est simplement
 * hors reseau est un mensonge, et sur un produit de pointage un mensonge
 * d'interface se transforme vite en litige avec un salarie.
 */
export function StateBoundary({ isLoading, isError, error, data, empty, skeleton, children, onRetry, isOffline = false, queuedCount = 0, }) {
    if (import.meta.env.DEV && empty.body.length < MIN_EMPTY_BODY_LENGTH) {
        throw new Error(`Etat vide insuffisant : « ${empty.body} » fait ${empty.body.length} caracteres, ` +
            `le minimum est ${MIN_EMPTY_BODY_LENGTH}. Expliquez ce qui apparaitra ici et quand, ` +
            'et proposez une action. Voir cahier des charges l. 1544-1552.');
    }
    if (isOffline) {
        return (_jsxs(Panel, { accent: "orange", className: "p-6 text-center", children: [_jsx("p", { className: "font-bold text-offwhite", children: "Hors ligne" }), _jsx("p", { className: "mt-2 text-xs text-muted", children: queuedCount > 0
                        ? `${queuedCount} pointage(s) en attente de synchronisation. Ils seront transmis automatiquement au retour du reseau.`
                        : 'Les donnees affichees datent de votre derniere connexion. Elles se mettront a jour automatiquement.' })] }));
    }
    if (isError) {
        return (_jsxs(Panel, { accent: "red", className: "p-6 text-center", children: [_jsx("p", { className: "font-bold text-offwhite", children: error?.title ?? 'Une erreur technique est survenue' }), _jsx("p", { className: "mt-2 text-xs text-muted", children: error?.body ?? "Nos equipes ont ete informees de l'incident." }), error?.action ? _jsx("p", { className: "mt-1 text-xs text-muted", children: error.action }) : null, onRetry ? (_jsx("button", { type: "button", onClick: onRetry, className: "magnetic-btn mt-4 min-h-tap rounded-xl border border-subtle bg-subtle px-5 py-2.5 text-xs font-bold text-offwhite", children: "Reessayer" })) : null] }));
    }
    if (isLoading)
        return _jsx(_Fragment, { children: skeleton });
    if (!data || data.length === 0) {
        return (_jsxs(Panel, { className: "p-8 text-center", children: [_jsx("p", { className: "font-bold text-offwhite", children: empty.title }), _jsx("p", { className: "mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted", children: empty.body }), empty.action ? (_jsx("button", { type: "button", onClick: empty.action.onClick, className: "magnetic-btn mt-5 min-h-tap rounded-xl bg-gradient-to-r from-gold via-orange to-green px-6 py-2.5 text-xs font-bold text-white", children: empty.action.label })) : null] }));
    }
    return _jsx(_Fragment, { children: children(data) });
}
//# sourceMappingURL=StateBoundary.js.map