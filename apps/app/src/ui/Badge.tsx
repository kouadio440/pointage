import type { ReactNode } from 'react';

/** Etats metier du pointage, alignes sur WorkDayStatus cote base. */
export type BadgeVariant = 'verified' | 'alert' | 'danger' | 'info' | 'neutral';

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  verified: 'badge-verified',
  alert: 'badge-alert',
  danger: 'badge-danger',
  info: 'badge-info',
  neutral: 'bg-subtle text-muted border border-subtle',
};

/**
 * Correspondance statut metier -> variante visuelle.
 *
 * Centralisee ici a dessein : dans le prototype, la correspondance etait
 * dispersee dans les fonctions de rendu, et le statut « Sorti » — pourtant
 * ecrit par le code de pointage — n'avait aucun badge et retombait
 * silencieusement sur le rouge « Absent ».
 */
export const STATUS_VARIANT: Record<string, BadgeVariant> = {
  PRESENT: 'verified',
  LATE: 'alert',
  ABSENT: 'danger',
  ON_LEAVE: 'info',
  ON_MISSION: 'info',
  HOLIDAY: 'neutral',
  REST_DAY: 'neutral',
  NOT_STARTED: 'neutral',
  ACCEPTED: 'verified',
  PENDING_REVIEW: 'alert',
  REJECTED: 'danger',
};

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

export function Badge({ children, variant = 'neutral', className = '' }: BadgeProps) {
  return (
    <span
      className={`${VARIANT_CLASS[variant]} inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold ${className}`.trim()}
    >
      {children}
    </span>
  );
}

/** Badge derive d'un statut metier, avec repli explicite sur « neutral ». */
export function StatusBadge({ status, label }: { status: string; label: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? 'neutral'}>{label}</Badge>;
}
