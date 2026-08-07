import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role, Scope } from '@pointage/shared';

/**
 * Contexte de la requete en cours.
 *
 * Porte par AsyncLocalStorage plutot que passe en parametre : sinon, il suffit
 * d'UN service qui oublie de propager le companyId pour ouvrir une fuite entre
 * entreprises. Ici, l'oubli est impossible - la couche d'acces aux donnees lit
 * le contexte elle-meme.
 */
export interface RequestContext {
  requestId: string;
  companyId: string;
  userId: string;
  role: Role;
  scope: Scope;
  /** Renseigne quand l'utilisateur est aussi un employe (pointage, conges). */
  employeeId?: string;
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Execute `fn` avec le contexte donne. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Contexte courant, ou `undefined` hors requete (taches planifiees, seed). */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Contexte courant, ou exception.
 *
 * Utilise par tout ce qui DOIT etre cloisonne. Lever une exception est le
 * comportement sur : renvoyer `undefined` conduirait a une requete sans filtre
 * tenant, donc a servir les donnees de toutes les entreprises.
 */
export function requireContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'Contexte de requete absent. Toute operation sur des donnees client doit ' +
        "s'executer dans runWithContext(). Pour une tache systeme legitime " +
        '(seed, migration, cron plateforme), utilisez runAsSystem().',
    );
  }
  return ctx;
}

/**
 * Marqueur d'execution systeme.
 *
 * Certaines operations sont legitimement hors tenant : seed, migrations, cron
 * de facturation qui balaye toutes les entreprises. Elles doivent le DECLARER,
 * pour qu'un oubli de contexte reste une erreur et non un contournement discret.
 */
export const SYSTEM_COMPANY_ID = '00000000-0000-0000-0000-000000000000';

export function runAsSystem<T>(requestId: string, fn: () => T): T {
  return storage.run(
    {
      requestId,
      companyId: SYSTEM_COMPANY_ID,
      userId: SYSTEM_COMPANY_ID,
      role: 'SUPER_ADMIN',
      scope: 'PLATFORM',
    },
    fn,
  );
}

export function isSystemContext(ctx: RequestContext): boolean {
  return ctx.companyId === SYSTEM_COMPANY_ID;
}
