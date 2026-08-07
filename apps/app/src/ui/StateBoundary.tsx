import type { ReactNode } from 'react';
import { Panel } from './Panel.js';

/**
 * Etat vide, avec une contrainte volontairement forte.
 *
 * `body` doit faire au moins 40 caracteres. Le cahier des charges (l. 1544-1552)
 * interdit les messages secs du type « Aucun pointage » : il faut dire ce qui
 * se passera et proposer une action. La regle est portee par le TYPE et par une
 * assertion a l'execution, pour qu'aucun ecran ne puisse etre livre sans.
 */
export interface EmptyState {
  title: string;
  /** Au moins 40 caracteres : expliquez ce qui apparaitra ici et quand. */
  body: string;
  action?: { label: string; onClick: () => void };
}

export const MIN_EMPTY_BODY_LENGTH = 40;

interface StateBoundaryProps<T> {
  /** Etat brut de la requete serveur. */
  isLoading: boolean;
  isError: boolean;
  error?: { title: string; body: string; action?: string } | undefined;
  data: T[] | undefined;
  /** Obligatoire : un ecran sans etat vide redige n'est pas livrable. */
  empty: EmptyState;
  skeleton: ReactNode;
  children: (data: T[]) => ReactNode;
  onRetry?: () => void;
  isOffline?: boolean;
  queuedCount?: number;
}

/**
 * Ordre de priorite d'affichage : hors ligne > erreur > chargement > vide > contenu.
 *
 * Cet ordre compte. Afficher « aucune donnee » a quelqu'un qui est simplement
 * hors reseau est un mensonge, et sur un produit de pointage un mensonge
 * d'interface se transforme vite en litige avec un salarie.
 */
export function StateBoundary<T>({
  isLoading,
  isError,
  error,
  data,
  empty,
  skeleton,
  children,
  onRetry,
  isOffline = false,
  queuedCount = 0,
}: StateBoundaryProps<T>) {
  if (import.meta.env.DEV && empty.body.length < MIN_EMPTY_BODY_LENGTH) {
    throw new Error(
      `Etat vide insuffisant : « ${empty.body} » fait ${empty.body.length} caracteres, ` +
        `le minimum est ${MIN_EMPTY_BODY_LENGTH}. Expliquez ce qui apparaitra ici et quand, ` +
        'et proposez une action. Voir cahier des charges l. 1544-1552.',
    );
  }

  if (isOffline) {
    return (
      <Panel accent="orange" className="p-6 text-center">
        <p className="font-bold text-offwhite">Hors ligne</p>
        <p className="mt-2 text-xs text-muted">
          {queuedCount > 0
            ? `${queuedCount} pointage(s) en attente de synchronisation. Ils seront transmis automatiquement au retour du reseau.`
            : 'Les donnees affichees datent de votre derniere connexion. Elles se mettront a jour automatiquement.'}
        </p>
      </Panel>
    );
  }

  if (isError) {
    return (
      <Panel accent="red" className="p-6 text-center">
        <p className="font-bold text-offwhite">
          {error?.title ?? 'Une erreur technique est survenue'}
        </p>
        <p className="mt-2 text-xs text-muted">
          {error?.body ?? "Nos equipes ont ete informees de l'incident."}
        </p>
        {error?.action ? <p className="mt-1 text-xs text-muted">{error.action}</p> : null}
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="magnetic-btn mt-4 min-h-tap rounded-xl border border-subtle bg-subtle px-5 py-2.5 text-xs font-bold text-offwhite"
          >
            Reessayer
          </button>
        ) : null}
      </Panel>
    );
  }

  if (isLoading) return <>{skeleton}</>;

  if (!data || data.length === 0) {
    return (
      <Panel className="p-8 text-center">
        <p className="font-bold text-offwhite">{empty.title}</p>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted">{empty.body}</p>
        {empty.action ? (
          <button
            type="button"
            onClick={empty.action.onClick}
            className="magnetic-btn mt-5 min-h-tap rounded-xl bg-gradient-to-r from-gold via-orange to-green px-6 py-2.5 text-xs font-bold text-white"
          >
            {empty.action.label}
          </button>
        ) : null}
      </Panel>
    );
  }

  return <>{children(data)}</>;
}
