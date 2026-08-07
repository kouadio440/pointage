import { Prisma } from '@prisma/client';
import { getContext, isSystemContext, SYSTEM_COMPANY_ID } from '../tenant/tenant-context.js';

/**
 * Premier mur d'isolation multi-entreprises.
 *
 * Toute requete Prisma sur un modele cloisonne se voit injecter le filtre
 * `companyId` du contexte courant. Le developpeur n'a rien a penser, et surtout
 * rien a oublier : c'est la seule facon d'obtenir une garantie qui tienne sur
 * des dizaines de modules ecrits par plusieurs personnes.
 *
 * FAIL-CLOSED : sans contexte, on LEVE une exception. Le comportement inverse
 * (requeter sans filtre) transformerait un oubli en fuite de donnees entre
 * clients, silencieuse et indetectable.
 *
 * Le second mur (RLS PostgreSQL) arrive en phase 6. Les deux sont independants :
 * une faille dans ce code ne suffira pas a franchir la base.
 */

/**
 * Modeles SANS companyId, legitimement globaux.
 * Doit rester synchronise avec GLOBAL_MODELS de scripts/check-tenant-scoping.mjs.
 */
const GLOBAL_MODELS = new Set<string>(['Plan', 'Company', 'PlatformAuditLog']);

/**
 * Operations dont le filtre tenant va dans `where`.
 *
 * `findUnique`, `findUniqueOrThrow`, `update` et `delete` en font partie grace a
 * `extendedWhereUnique`, stable depuis Prisma 5 : leur `where` accepte des
 * filtres non uniques en plus de la cle. C'est essentiel ici, sinon connaitre
 * un UUID suffirait a lire la ligne d'une autre entreprise.
 */
const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

export function createTenantExtension() {
  return Prisma.defineExtension({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || GLOBAL_MODELS.has(model)) {
            return query(args);
          }

          const ctx = getContext();

          if (!ctx) {
            throw new Error(
              `Acces a « ${model} » hors contexte de requete (operation « ${operation} »). ` +
                "Executez l'operation dans runWithContext(), ou declarez-la explicitement " +
                'comme tache systeme via runAsSystem().',
            );
          }

          // Une tache systeme declaree (seed, cron plateforme) balaye toutes
          // les entreprises. C'est un choix explicite, pas un contournement.
          if (isSystemContext(ctx)) {
            return query(args);
          }

          if (!ctx.companyId || ctx.companyId === SYSTEM_COMPANY_ID) {
            throw new Error(`Contexte sans companyId valide pour « ${model} ». Requete refusee.`);
          }

          const companyId = ctx.companyId;
          const a = (args ?? {}) as Record<string, unknown>;

          // --- Lectures et ecritures ciblees ---------------------------------
          if (WHERE_OPS.has(operation)) {
            return query({
              ...a,
              where: { ...(a.where as object | undefined), companyId },
            } as never);
          }

          // --- Creations ------------------------------------------------------
          if (operation === 'create') {
            return query({
              ...a,
              data: { ...(a.data as object), companyId },
            } as never);
          }

          if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const data = a.data;
            const withTenant = Array.isArray(data)
              ? data.map((row) => ({ ...(row as object), companyId }))
              : { ...(data as object), companyId };
            return query({ ...a, data: withTenant } as never);
          }

          if (operation === 'upsert') {
            return query({
              ...a,
              where: { ...(a.where as object), companyId },
              create: { ...(a.create as object), companyId },
            } as never);
          }

          // Toute operation non prevue est refusee plutot que laissee passer :
          // un nouvel operateur Prisma ne doit pas creer un trou par defaut.
          throw new Error(
            `Operation « ${operation} » non couverte par l'isolation tenant sur « ${model} ». ` +
              'Ajoutez-la explicitement dans tenant-extension.ts.',
          );
        },
      },
    },
  });
}
