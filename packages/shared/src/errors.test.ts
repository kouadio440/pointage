import { describe, expect, it } from 'vitest';
import { ERROR_COPY, errorStatus, renderError, type ErrorCode } from './errors.js';

const CODES = Object.keys(ERROR_COPY) as ErrorCode[];

describe('qualite redactionnelle du catalogue', () => {
  it('donne un titre lisible a chaque code', () => {
    for (const code of CODES) {
      const { title } = ERROR_COPY[code];
      expect(title.length, `${code} : titre trop court`).toBeGreaterThan(8);
      // Un titre en MAJUSCULES ou en anglais technique n'a rien a faire devant un employe.
      expect(title, `${code} : titre tout en majuscules`).not.toBe(title.toUpperCase());
    }
  });

  it('interdit les messages secs proscrits par le cahier des charges', () => {
    const interdits = ['erreur', 'error', 'invalid', 'failed', 'forbidden', 'not found'];
    for (const code of CODES) {
      const titre = ERROR_COPY[code].title.toLowerCase();
      for (const mot of interdits) {
        expect(titre === mot, `${code} : titre reduit a "${mot}"`).toBe(false);
      }
    }
  });

  it("accompagne chaque message d'une consigne, sauf quand il n'y a rien a faire", () => {
    // Seul RBAC_OUT_OF_SCOPE n'a pas d'action : on ne guide pas quelqu'un
    // vers une ressource dont on refuse de confirmer l'existence.
    const sansAction = CODES.filter((c) => ERROR_COPY[c].action === undefined);
    expect(sansAction).toEqual(['RBAC_OUT_OF_SCOPE']);
  });

  it('associe un statut HTTP plausible a chaque code', () => {
    for (const code of CODES) {
      const s = ERROR_COPY[code].status;
      const valide = s === 0 || (s >= 200 && s < 600);
      expect(valide, `${code} : statut ${s} invalide`).toBe(true);
    }
  });
});

describe('regles de securite encodees dans le catalogue', () => {
  it("ne revele pas si un identifiant existe lors d'un echec de connexion", () => {
    const msg = renderError('AUTH_INVALID_CREDENTIALS', undefined);
    const texte = `${msg.title} ${msg.body}`.toLowerCase();
    expect(texte).not.toContain('inconnu');
    expect(texte).not.toContain("n'existe pas");
    expect(texte).not.toContain('mot de passe incorrect');
  });

  it('renvoie 404 et non 403 pour un acces hors perimetre', () => {
    // Un 403 confirmerait l'existence de la ressource visee.
    expect(errorStatus('RBAC_OUT_OF_SCOPE')).toBe(404);
  });

  it("renvoie 402 pour un abonnement suspendu, ce qui declenche l'interstitiel", () => {
    expect(errorStatus('SUBSCRIPTION_SUSPENDED')).toBe(402);
    expect(errorStatus('SUBSCRIPTION_PENDING_PAYMENT')).toBe(402);
  });

  it("renvoie 409 au plafond de sieges, avec le detail de l'offre", () => {
    expect(errorStatus('SUBSCRIPTION_SEAT_LIMIT')).toBe(409);
    const msg = renderError('SUBSCRIPTION_SEAT_LIMIT', {
      plan: 'Starter PME',
      current: 15,
      max: 15,
    });
    expect(msg.body).toContain('Starter PME');
    expect(msg.body).toContain('15');
  });
});

describe('renderError', () => {
  it('chiffre le refus de geofence avec la distance reelle et le rayon', () => {
    const msg = renderError('PUNCH_OUTSIDE_FENCE', {
      distanceM: 412,
      siteName: 'Siege Principal',
      radiusM: 150,
    });

    expect(msg.title).toBe('Pointage refuse - hors de la zone autorisee');
    expect(msg.body).toBe('Vous etes a 412 m de Siege Principal. La zone autorisee est de 150 m.');
    expect(msg.action).toBe('Rapprochez-vous du site, puis reessayez.');
  });

  it('explique un echec de reconnaissance faciale avec le score obtenu', () => {
    const msg = renderError('PUNCH_FACE_MISMATCH', { score: 61, threshold: 80 });
    expect(msg.body).toContain('61 %');
    expect(msg.body).toContain('80 %');
    expect(msg.action).toContain('lunettes');
  });

  it('indique le nombre de pointages en attente en mode hors ligne', () => {
    const msg = renderError('OFFLINE_QUEUED', { queued: 3 });
    expect(msg.body).toContain('3 pointage(s)');
    expect(msg.body).toContain('automatiquement');
  });

  it("fournit une reference exploitable par le support en cas d'erreur interne", () => {
    const msg = renderError('INTERNAL_ERROR', { requestId: 'req_01J8XYZ' });
    expect(msg.body).toContain('req_01J8XYZ');
  });

  it("omet la cle action quand le code n'en definit pas", () => {
    const msg = renderError('RBAC_OUT_OF_SCOPE', undefined);
    expect(msg.action).toBeUndefined();
    expect('action' in msg).toBe(false);
  });

  it("produit un texte pour chaque code sans jamais lever d'exception", () => {
    for (const code of CODES) {
      // Les parametres reels different selon le code ; un objet de test generique
      // suffit a prouver qu'aucun modele ne plante a l'interpolation.
      const params = {
        minutes: 15,
        attemptsLeft: 2,
        validMinutes: 10,
        permission: 'LEAVE:VALIDER',
        distanceM: 412,
        siteName: 'Siege',
        radiusM: 150,
        accuracyM: 180,
        maxAccuracyM: 100,
        score: 61,
        threshold: 80,
        deviceLabel: 'Chrome/Android',
        rotationSeconds: 30,
        at: '08:02',
        type: 'IN',
        waitSeconds: 30,
        driftMinutes: 22,
        distanceKm: 300,
        since: '01/08/2026',
        plan: 'Starter',
        current: 16,
        max: 15,
        maxMb: 2,
        allowed: 'JPEG, PNG',
        fields: 'email',
        retryAfterSeconds: 60,
        queued: 3,
        requestId: 'req_1',
      } as never;

      expect(() => renderError(code, params), `${code} plante a l'interpolation`).not.toThrow();
      expect(renderError(code, params).body.length).toBeGreaterThan(10);
    }
  });
});
