import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { APP_TIMEZONE } from '@pointage/design-tokens';
import { formatClock, formatDate } from '@pointage/shared';
import { useEffect, useState } from 'react';
import { Panel } from '../../ui/Panel.js';
import { StateBoundary } from '../../ui/StateBoundary.js';
import { StatusBadge } from '../../ui/Badge.js';
/**
 * Espace employe - « Mon temps de travail ».
 *
 * Mobile-first : c'est l'ecran le plus utilise du produit, majoritairement
 * depuis un telephone, souvent en reseau degrade.
 *
 * Squelette de phase 0 : la structure, le fuseau officiel et les etats
 * obligatoires sont en place. Le pointage reel (GPS, selfie, moteur anti-fraude)
 * arrive en phase 3, une fois l'authentification et le cloisonnement poses.
 */
export default function EspaceEmploye() {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        // Horloge officielle Africa/Abidjan, comme la barre du site vitrine.
        const id = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(id);
    }, []);
    return (_jsxs("div", { className: "mx-auto max-w-3xl space-y-6 px-4 py-6", children: [_jsxs("header", { className: "space-y-1", children: [_jsx("p", { className: "font-mono text-xs uppercase tracking-widest text-muted", children: formatDate(now, APP_TIMEZONE) }), _jsx("h1", { className: "text-2xl font-extrabold text-offwhite", children: "Mon temps de travail" }), _jsx("p", { className: "tabular text-xs text-gold", children: formatClock(now, APP_TIMEZONE) })] }), _jsx(Panel, { accent: "green", className: "p-6", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("p", { className: "text-xs text-muted", children: "Statut du jour" }), _jsx("p", { className: "mt-1 text-lg font-bold text-offwhite", children: "Pas encore pointe" })] }), _jsx(StatusBadge, { status: "NOT_STARTED", label: "NON POINTE" })] }) }), _jsxs("section", { className: "space-y-3", children: [_jsx("h2", { className: "text-sm font-bold text-offwhite", children: "Mes derniers pointages" }), _jsx(StateBoundary, { isLoading: false, isError: false, data: [], skeleton: _jsx(Panel, { className: "h-40 animate-pulse" }), empty: {
                            title: "Aucun pointage enregistre aujourd'hui",
                            body: "Vos arrivees et departs apparaitront ici des votre premier pointage de la journee, avec l'heure officielle et le site concerne.",
                        }, children: (rows) => _jsx("div", { children: rows.length }) })] })] }));
}
//# sourceMappingURL=EspaceEmploye.js.map