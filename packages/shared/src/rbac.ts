/**
 * Modele de roles et permissions.
 *
 * Le cahier des charges (l. 1143-1152) impose 8 verbes de permission. On les
 * croise avec une ressource pour obtenir une permission atomique du type
 * `EMPLOYEE:MODIFIER`. Chaque route de l'API en declare une, et un garde la
 * verifie - il n'y a AUCUN controle d'acces implicite.
 *
 * Ce fichier est partage entre l'API (qui applique) et le front (qui masque
 * les actions interdites). Le front masque par confort ; c'est l'API qui decide.
 */

export const ROLES = ['SUPER_ADMIN', 'CEO', 'HR', 'MANAGER', 'EMPLOYEE'] as const;
export type Role = (typeof ROLES)[number];

/** Les 8 verbes du cahier des charges. */
export const ACTIONS = [
  'CONSULTER',
  'AJOUTER',
  'MODIFIER',
  'SUPPRIMER',
  'VALIDER',
  'EXPORTER',
  'ADMINISTRER',
  'VOIR_PREUVES_SENSIBLES',
] as const;
export type Action = (typeof ACTIONS)[number];

export const RESOURCES = [
  'COMPANY',
  'SITE',
  'DEPARTMENT',
  'POSITION',
  'EMPLOYEE',
  'SCHEDULE',
  'HOLIDAY',
  'PUNCH',
  'WORKDAY',
  'LATENESS',
  'LEAVE',
  'EXIT',
  'OVERTIME',
  'MISSION',
  'VISIT',
  'CLIENT',
  'REPORT',
  'NOTIFICATION',
  'FRAUD',
  'DEVICE',
  'BILLING',
  'AUDIT',
  'PLATFORM',
] as const;
export type Resource = (typeof RESOURCES)[number];

export type Permission = `${Resource}:${Action}`;

export function permission(resource: Resource, action: Action): Permission {
  return `${resource}:${action}`;
}

/**
 * Portee d'une permission. Determine QUELLES lignes le titulaire peut toucher,
 * une fois qu'il a le droit de faire l'action.
 *
 * Regle non negociable : un acces hors portee renvoie 404, jamais 403.
 * Un 403 confirmerait l'existence de la ressource et fuiterait de l'information
 * entre equipes ou entre entreprises.
 */
export const SCOPES = ['SELF', 'TEAM', 'SITE', 'COMPANY', 'PLATFORM'] as const;
export type Scope = (typeof SCOPES)[number];

const SCOPE_RANK: Record<Scope, number> = {
  SELF: 0,
  TEAM: 1,
  SITE: 2,
  COMPANY: 3,
  PLATFORM: 4,
};

/** `true` si `held` est au moins aussi large que `required`. */
export function scopeCovers(held: Scope, required: Scope): boolean {
  return SCOPE_RANK[held] >= SCOPE_RANK[required];
}

/** Portee maximale accordee a chaque role. */
export const ROLE_MAX_SCOPE: Record<Role, Scope> = {
  SUPER_ADMIN: 'PLATFORM',
  CEO: 'COMPANY',
  HR: 'COMPANY',
  MANAGER: 'TEAM',
  EMPLOYEE: 'SELF',
};

const all = (resource: Resource, ...actions: Action[]): Permission[] =>
  actions.map((a) => permission(resource, a));

const crud = (resource: Resource): Permission[] =>
  all(resource, 'CONSULTER', 'AJOUTER', 'MODIFIER', 'SUPPRIMER');

/**
 * Grants par defaut, seeds en base au demarrage.
 *
 * Ils sont modifiables par entreprise ensuite (table RolePermissionGrant) :
 * certaines PME veulent qu'un manager puisse creer un employe, d'autres non.
 * Cette table n'est donc qu'un point de depart, pas une verite figee dans le code.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Le super admin n'a AUCUNE permission metier sur les entreprises clientes.
  // Il administre la plateforme (abonnements, suspensions, support) et ne peut
  // pas lire les pointages ni les preuves biometriques d'un client.
  SUPER_ADMIN: [
    ...all('PLATFORM', 'CONSULTER', 'MODIFIER', 'ADMINISTRER'),
    ...all('BILLING', 'CONSULTER', 'MODIFIER', 'VALIDER', 'EXPORTER'),
    ...all('AUDIT', 'CONSULTER'),
  ],

  CEO: [
    ...all('COMPANY', 'CONSULTER', 'MODIFIER', 'ADMINISTRER'),
    ...crud('SITE'),
    ...crud('DEPARTMENT'),
    ...crud('POSITION'),
    ...crud('EMPLOYEE'),
    ...crud('SCHEDULE'),
    ...crud('HOLIDAY'),
    ...all('PUNCH', 'CONSULTER', 'EXPORTER'),
    ...all('WORKDAY', 'CONSULTER', 'EXPORTER'),
    ...all('LATENESS', 'CONSULTER', 'VALIDER', 'EXPORTER'),
    ...all('LEAVE', 'CONSULTER', 'VALIDER', 'EXPORTER'),
    ...all('EXIT', 'CONSULTER', 'VALIDER'),
    ...all('OVERTIME', 'CONSULTER', 'VALIDER', 'EXPORTER'),
    ...all('MISSION', 'CONSULTER', 'VALIDER'),
    ...all('VISIT', 'CONSULTER', 'EXPORTER'),
    ...all('CLIENT', 'CONSULTER'),
    ...all('REPORT', 'CONSULTER', 'AJOUTER', 'EXPORTER'),
    ...all('FRAUD', 'CONSULTER', 'VALIDER'),
    ...all('DEVICE', 'CONSULTER', 'MODIFIER'),
    ...all('BILLING', 'CONSULTER', 'EXPORTER'),
    ...all('AUDIT', 'CONSULTER'),
    ...all('NOTIFICATION', 'CONSULTER'),
  ],

  HR: [
    ...all('COMPANY', 'CONSULTER', 'MODIFIER'),
    ...crud('SITE'),
    ...crud('DEPARTMENT'),
    ...crud('POSITION'),
    ...crud('EMPLOYEE'),
    ...crud('SCHEDULE'),
    ...crud('HOLIDAY'),
    // Le RH est le seul a pouvoir creer un pointage manuel (module 5 du cahier
    // des charges) et a voir les selfies : ce sont des preuves sensibles.
    ...all('PUNCH', 'CONSULTER', 'AJOUTER', 'MODIFIER', 'EXPORTER', 'VOIR_PREUVES_SENSIBLES'),
    ...all('WORKDAY', 'CONSULTER', 'MODIFIER', 'EXPORTER'),
    ...all('LATENESS', 'CONSULTER', 'VALIDER', 'EXPORTER'),
    ...all('LEAVE', 'CONSULTER', 'AJOUTER', 'MODIFIER', 'VALIDER', 'EXPORTER'),
    ...all('EXIT', 'CONSULTER', 'VALIDER'),
    ...all('OVERTIME', 'CONSULTER', 'VALIDER', 'EXPORTER'),
    ...all('MISSION', 'CONSULTER', 'AJOUTER', 'MODIFIER', 'VALIDER'),
    ...all('VISIT', 'CONSULTER', 'EXPORTER'),
    ...crud('CLIENT'),
    ...all('REPORT', 'CONSULTER', 'AJOUTER', 'EXPORTER'),
    ...all('FRAUD', 'CONSULTER', 'VALIDER', 'VOIR_PREUVES_SENSIBLES'),
    ...all('DEVICE', 'CONSULTER', 'MODIFIER'),
    ...all('NOTIFICATION', 'CONSULTER'),
  ],

  MANAGER: [
    ...all('EMPLOYEE', 'CONSULTER'),
    ...all('SCHEDULE', 'CONSULTER'),
    ...all('PUNCH', 'CONSULTER'),
    ...all('WORKDAY', 'CONSULTER'),
    ...all('LATENESS', 'CONSULTER', 'VALIDER'),
    ...all('LEAVE', 'CONSULTER', 'VALIDER'),
    ...all('EXIT', 'CONSULTER', 'VALIDER'),
    ...all('OVERTIME', 'CONSULTER', 'VALIDER'),
    ...all('MISSION', 'CONSULTER', 'AJOUTER', 'VALIDER'),
    ...all('VISIT', 'CONSULTER', 'VALIDER'),
    ...all('CLIENT', 'CONSULTER'),
    ...all('REPORT', 'CONSULTER'),
    ...all('NOTIFICATION', 'CONSULTER'),
  ],

  EMPLOYEE: [
    ...all('PUNCH', 'CONSULTER', 'AJOUTER'),
    ...all('WORKDAY', 'CONSULTER'),
    ...all('LATENESS', 'CONSULTER'),
    ...all('LEAVE', 'CONSULTER', 'AJOUTER', 'SUPPRIMER'),
    ...all('EXIT', 'CONSULTER', 'AJOUTER'),
    ...all('OVERTIME', 'CONSULTER'),
    ...all('MISSION', 'CONSULTER'),
    ...all('VISIT', 'CONSULTER', 'AJOUTER'),
    ...all('CLIENT', 'CONSULTER'),
    ...all('NOTIFICATION', 'CONSULTER'),
  ],
};

/**
 * Permissions qui donnent acces a des donnees biometriques ou a des preuves.
 * Toute lecture les concernant est journalisee dans AuditLog, meme reussie.
 */
export const SENSITIVE_PERMISSIONS: readonly Permission[] = [
  'PUNCH:VOIR_PREUVES_SENSIBLES',
  'FRAUD:VOIR_PREUVES_SENSIBLES',
];

export function isSensitive(p: Permission): boolean {
  return SENSITIVE_PERMISSIONS.includes(p);
}
