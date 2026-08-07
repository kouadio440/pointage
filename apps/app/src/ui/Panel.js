import { jsx as _jsx } from "react/jsx-runtime";
const ACCENT_CLASS = {
    gold: 'border-t-2 border-t-gold',
    green: 'border-t-2 border-t-green',
    orange: 'border-t-2 border-t-orange',
    cyan: 'border-t-2 border-t-cyan',
    red: 'border-t-2 border-t-red',
};
/**
 * Surface de base. Portage direct de `.glass-panel` du site vitrine.
 *
 * Les couleurs passent toutes par des tokens : c'est ce qui fait que les trois
 * themes fonctionnent, alors que la maquette actuelle du dashboard code
 * `slate-*` en dur et casse le theme clair.
 */
export function Panel({ children, tone = 'default', accent = null, className = '', as: Tag = 'div', }) {
    const base = tone === 'elevated' ? 'glass-panel-elevated' : 'glass-panel';
    const accentClass = accent ? ACCENT_CLASS[accent] : '';
    return _jsx(Tag, { className: `${base} ${accentClass} ${className}`.trim(), children: children });
}
//# sourceMappingURL=Panel.js.map