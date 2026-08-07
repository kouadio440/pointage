import type { ReactNode } from 'react';

type PanelTone = 'default' | 'elevated';

interface PanelProps {
  /** Optionnel : un panneau vide sert de squelette de chargement. */
  children?: ReactNode;
  tone?: PanelTone;
  /** Liseré d'accent en haut du panneau, comme sur les cartes du site vitrine. */
  accent?: 'gold' | 'green' | 'orange' | 'cyan' | 'red' | null;
  className?: string;
  as?: 'div' | 'section' | 'article';
}

const ACCENT_CLASS: Record<NonNullable<PanelProps['accent']>, string> = {
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
export function Panel({
  children,
  tone = 'default',
  accent = null,
  className = '',
  as: Tag = 'div',
}: PanelProps) {
  const base = tone === 'elevated' ? 'glass-panel-elevated' : 'glass-panel';
  const accentClass = accent ? ACCENT_CLASS[accent] : '';

  return <Tag className={`${base} ${accentClass} ${className}`.trim()}>{children}</Tag>;
}
