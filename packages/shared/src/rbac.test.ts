import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  DEFAULT_ROLE_PERMISSIONS,
  isSensitive,
  permission,
  RESOURCES,
  ROLE_MAX_SCOPE,
  ROLES,
  scopeCovers,
  type Permission,
  type Role,
} from './rbac.js';

const has = (role: Role, p: Permission): boolean => DEFAULT_ROLE_PERMISSIONS[role].includes(p);

describe('coherence du modele', () => {
  it("compose une permission a partir d'une ressource et d'une action", () => {
    expect(permission('EMPLOYEE', 'MODIFIER')).toBe('EMPLOYEE:MODIFIER');
  });

  it('expose les 8 verbes du cahier des charges', () => {
    expect(ACTIONS).toHaveLength(8);
    expect(ACTIONS).toContain('VOIR_PREUVES_SENSIBLES');
  });

  it('definit un jeu de permissions pour chaque role', () => {
    for (const role of ROLES) {
      expect(DEFAULT_ROLE_PERMISSIONS[role].length, `role ${role} sans permission`).toBeGreaterThan(
        0,
      );
    }
  });

  it("n'accorde que des permissions bien formees", () => {
    for (const role of ROLES) {
      for (const p of DEFAULT_ROLE_PERMISSIONS[role]) {
        const [resource, action] = p.split(':');
        expect(RESOURCES, `${p} : ressource inconnue`).toContain(resource);
        expect(ACTIONS, `${p} : action inconnue`).toContain(action);
      }
    }
  });

  it('ne contient aucun doublon', () => {
    for (const role of ROLES) {
      const list = DEFAULT_ROLE_PERMISSIONS[role];
      expect(new Set(list).size, `doublon dans ${role}`).toBe(list.length);
    }
  });
});

describe('cloisonnement des roles', () => {
  it('le super admin ne peut PAS lire les pointages des entreprises clientes', () => {
    expect(has('SUPER_ADMIN', 'PUNCH:CONSULTER')).toBe(false);
    expect(has('SUPER_ADMIN', 'EMPLOYEE:CONSULTER')).toBe(false);
  });

  it('le super admin ne peut PAS voir les preuves biometriques', () => {
    expect(has('SUPER_ADMIN', 'PUNCH:VOIR_PREUVES_SENSIBLES')).toBe(false);
    expect(has('SUPER_ADMIN', 'FRAUD:VOIR_PREUVES_SENSIBLES')).toBe(false);
  });

  it("seuls le RH et le CEO administrent l'entreprise", () => {
    expect(has('HR', 'COMPANY:MODIFIER')).toBe(true);
    expect(has('CEO', 'COMPANY:ADMINISTRER')).toBe(true);
    expect(has('MANAGER', 'COMPANY:MODIFIER')).toBe(false);
    expect(has('EMPLOYEE', 'COMPANY:MODIFIER')).toBe(false);
  });

  it('le pointage manuel est reserve au RH (module 5)', () => {
    expect(has('HR', 'PUNCH:AJOUTER')).toBe(true);
    expect(has('HR', 'PUNCH:MODIFIER')).toBe(true);
    expect(has('MANAGER', 'PUNCH:MODIFIER')).toBe(false);
    expect(has('CEO', 'PUNCH:MODIFIER')).toBe(false);
  });

  it('un employe ne valide jamais rien', () => {
    for (const resource of RESOURCES) {
      expect(
        has('EMPLOYEE', permission(resource, 'VALIDER')),
        `l'employe ne doit pas valider ${resource}`,
      ).toBe(false);
    }
  });

  it('un employe ne peut ni supprimer un collegue ni exporter des donnees', () => {
    expect(has('EMPLOYEE', 'EMPLOYEE:SUPPRIMER')).toBe(false);
    for (const resource of RESOURCES) {
      expect(has('EMPLOYEE', permission(resource, 'EXPORTER'))).toBe(false);
    }
  });

  it('un manager ne peut pas creer ou supprimer un employe par defaut', () => {
    expect(has('MANAGER', 'EMPLOYEE:CONSULTER')).toBe(true);
    expect(has('MANAGER', 'EMPLOYEE:AJOUTER')).toBe(false);
    expect(has('MANAGER', 'EMPLOYEE:SUPPRIMER')).toBe(false);
  });

  it('un manager ne voit pas les selfies : ce sont des preuves sensibles', () => {
    expect(has('MANAGER', 'PUNCH:VOIR_PREUVES_SENSIBLES')).toBe(false);
    expect(has('HR', 'PUNCH:VOIR_PREUVES_SENSIBLES')).toBe(true);
  });

  it('seul le super admin touche a la facturation en modification', () => {
    expect(has('SUPER_ADMIN', 'BILLING:VALIDER')).toBe(true);
    expect(has('CEO', 'BILLING:CONSULTER')).toBe(true);
    expect(has('CEO', 'BILLING:VALIDER')).toBe(false);
    expect(has('HR', 'BILLING:CONSULTER')).toBe(false);
  });

  it('un employe peut pointer et demander un conge, rien de plus sur ces objets', () => {
    expect(has('EMPLOYEE', 'PUNCH:AJOUTER')).toBe(true);
    expect(has('EMPLOYEE', 'LEAVE:AJOUTER')).toBe(true);
    expect(has('EMPLOYEE', 'LEAVE:SUPPRIMER')).toBe(true); // annulation de sa propre demande
    expect(has('EMPLOYEE', 'LEAVE:VALIDER')).toBe(false);
  });
});

describe('portees', () => {
  it('classe les portees de la plus etroite a la plus large', () => {
    expect(scopeCovers('COMPANY', 'TEAM')).toBe(true);
    expect(scopeCovers('TEAM', 'COMPANY')).toBe(false);
    expect(scopeCovers('SELF', 'SELF')).toBe(true);
    expect(scopeCovers('PLATFORM', 'COMPANY')).toBe(true);
  });

  it('borne chaque role a sa portee maximale', () => {
    expect(ROLE_MAX_SCOPE.EMPLOYEE).toBe('SELF');
    expect(ROLE_MAX_SCOPE.MANAGER).toBe('TEAM');
    expect(ROLE_MAX_SCOPE.HR).toBe('COMPANY');
    expect(ROLE_MAX_SCOPE.CEO).toBe('COMPANY');
    expect(ROLE_MAX_SCOPE.SUPER_ADMIN).toBe('PLATFORM');
  });

  it('un employe ne peut pas atteindre la portee equipe', () => {
    expect(scopeCovers(ROLE_MAX_SCOPE.EMPLOYEE, 'TEAM')).toBe(false);
  });

  it('un manager ne peut pas atteindre la portee entreprise', () => {
    expect(scopeCovers(ROLE_MAX_SCOPE.MANAGER, 'COMPANY')).toBe(false);
  });

  it('un CEO ne peut pas atteindre la portee plateforme', () => {
    expect(scopeCovers(ROLE_MAX_SCOPE.CEO, 'PLATFORM')).toBe(false);
  });
});

describe('permissions sensibles', () => {
  it('identifie les acces aux preuves biometriques', () => {
    expect(isSensitive('PUNCH:VOIR_PREUVES_SENSIBLES')).toBe(true);
    expect(isSensitive('FRAUD:VOIR_PREUVES_SENSIBLES')).toBe(true);
    expect(isSensitive('PUNCH:CONSULTER')).toBe(false);
  });
});
