// Authentification serveur a serveur : Vercel -> serveur de paiement.
//
// Chaque requete interne porte trois en-tetes :
//   X-Timora-Timestamp  secondes Unix au moment de la signature
//   X-Timora-Nonce      identifiant unique (jamais deux fois le meme)
//   X-Timora-Signature  v1=<HMAC-SHA256 hexadecimal>
//
// HMAC-SHA256, cle INTERNAL_PAYMENT_API_SECRET, sur la chaine :
//   "v1" \n METHODE \n CHEMIN (avec la requete) \n HORODATAGE \n NONCE
//        \n SHA256(jeton de session transmis, ou "") \n CORPS BRUT
//
// Le jeton de session de l'utilisateur (X-Timora-User-Token) est ainsi lie a
// la signature : il ne peut pas etre remplace dans une requete interceptee.
// Le serveur refuse : signature fausse, horodatage a plus de 5 minutes,
// nonce deja vu, requete signee avant son propre demarrage (le cache des
// nonces repart vide). Comparaison a temps constant.

import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export const ENTETE_HORODATAGE = 'x-timora-timestamp';
export const ENTETE_NONCE = 'x-timora-nonce';
export const ENTETE_SIGNATURE = 'x-timora-signature';
export const ENTETE_JETON = 'x-timora-user-token';
export const TOLERANCE_S = 300;

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE = /^v1=[0-9a-f]{64}$/;
const HORODATAGE = /^\d{9,11}$/;

const sha256 = (texte) => createHash('sha256').update(texte).digest('hex');

export function chaineASigner({ methode, chemin, horodatage, nonce, jeton, corps }) {
  return ['v1', String(methode).toUpperCase(), chemin, String(horodatage), nonce, sha256(jeton || ''), corps || ''].join('\n');
}

function hmac(secret, texte) {
  return createHmac('sha256', secret).update(texte).digest('hex');
}

/** En-tetes d'une requete interne signee (cote Vercel). */
export function signer({ secret, methode, chemin, corps = '', jeton = null, maintenant = Date.now() }) {
  if (!secret || secret.length < 32) throw new Error('Secret interne absent ou trop court.');
  const horodatage = Math.floor(maintenant / 1000);
  const nonce = randomUUID().replace(/-/g, '');
  const signature = hmac(secret, chaineASigner({ methode, chemin, horodatage, nonce, jeton, corps }));
  const entetes = {
    'X-Timora-Timestamp': String(horodatage),
    'X-Timora-Nonce': nonce,
    'X-Timora-Signature': `v1=${signature}`,
  };
  if (jeton) entetes['X-Timora-User-Token'] = jeton;
  return entetes;
}

/**
 * Nonces deja vus, gardes 2 x la tolerance. Taille bornee : au-dela, la
 * requete est refusee plutot que d'oublier un nonce encore valide.
 */
export class RegistreNonces {
  constructor({ dureeMs = 2 * TOLERANCE_S * 1000, capacite = 200000 } = {}) {
    this.dureeMs = dureeMs;
    this.capacite = capacite;
    this.vus = new Map();
  }

  purger(maintenant = Date.now()) {
    for (const [nonce, expire] of this.vus) {
      if (expire > maintenant) break; // insertion chronologique
      this.vus.delete(nonce);
    }
  }

  /** true si le nonce est nouveau (et le retient), false s'il a deja servi. */
  retenir(nonce, maintenant = Date.now()) {
    this.purger(maintenant);
    if (this.vus.has(nonce)) return false;
    if (this.vus.size >= this.capacite) return false;
    this.vus.set(nonce, maintenant + this.dureeMs);
    return true;
  }
}

/**
 * Verifie une requete interne (cote serveur de paiement).
 * Renvoie { ok: true } ou { ok: false, code }. Ne leve jamais d'exception.
 */
export function verifier({ secret, methode, chemin, entetes, corps = '', registre, demarrageS = 0, maintenant = Date.now() }) {
  const lire = (nom) => {
    const v = entetes[nom];
    return Array.isArray(v) ? v[0] : v;
  };
  const horodatage = String(lire(ENTETE_HORODATAGE) || '');
  const nonce = String(lire(ENTETE_NONCE) || '');
  const signature = String(lire(ENTETE_SIGNATURE) || '');
  const jeton = lire(ENTETE_JETON) || '';

  if (!secret || secret.length < 32) return { ok: false, code: 'SECRET_INTERNE_ABSENT' };
  if (!HORODATAGE.test(horodatage) || !NONCE.test(nonce) || !SIGNATURE.test(signature)) {
    return { ok: false, code: 'SIGNATURE_ABSENTE' };
  }

  const ts = Number(horodatage);
  const maintenantS = Math.floor(maintenant / 1000);
  if (Math.abs(maintenantS - ts) > TOLERANCE_S) return { ok: false, code: 'HORODATAGE_HORS_DELAI' };
  // Signee avant le demarrage du serveur : le registre des nonces ne la
  // connait pas, elle pourrait etre rejouee. Le client re-signe.
  if (ts < demarrageS) return { ok: false, code: 'HORODATAGE_HORS_DELAI' };

  const attendue = Buffer.from(hmac(secret, chaineASigner({ methode, chemin, horodatage: ts, nonce, jeton, corps })), 'hex');
  const recue = Buffer.from(signature.slice(3), 'hex');
  if (attendue.length !== recue.length || !timingSafeEqual(attendue, recue)) {
    return { ok: false, code: 'SIGNATURE_INVALIDE' };
  }

  // Le nonce n'est retenu qu'une fois la signature prouvee : un inconnu ne
  // peut pas remplir le registre.
  if (!registre.retenir(nonce, maintenant)) return { ok: false, code: 'NONCE_DEJA_UTILISE' };
  return { ok: true, jeton: jeton || null };
}
