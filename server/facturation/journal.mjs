// Journal de facturation.
//
// Une ligne JSON par evenement dans les journaux du serveur (Vercel), et, pour
// les evenements utiles au suivi d'un paiement, une copie en base
// (billing_events). Jamais de cle, de secret, de jeton, de signature ni
// d'en-tete sensible : les champs dont le nom les evoque sont retires, meme si
// l'appelant ne devrait jamais en fournir.

const SENSIBLE = /(key|secret|token|signature|authorization|password|cookie|jwt)/i;

export function nettoyer(details) {
  const propre = {};
  if (!details || typeof details !== 'object') return propre;
  for (const [cle, valeur] of Object.entries(details)) {
    if (SENSIBLE.test(cle) || valeur === undefined) continue;
    if (typeof valeur === 'string') {
      propre[cle] = valeur.length > 300 ? `${valeur.slice(0, 300)}…` : valeur;
    } else if (valeur === null || typeof valeur === 'number' || typeof valeur === 'boolean') {
      propre[cle] = valeur;
    } else if (Array.isArray(valeur)) {
      propre[cle] = valeur.slice(0, 20).map((v) => (typeof v === 'object' ? nettoyer(v) : v));
    } else {
      propre[cle] = nettoyer(valeur);
    }
  }
  return propre;
}

// Evenements qui demandent une attention humaine : niveau ALERTE, sortie
// d'erreur (journald les classe en priorite « err »).
export const ALERTES = new Set([
  'WEBHOOK_SIGNATURE_INVALID',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'UNKNOWN_PAYMENT',
  'DUPLICATE_PAYMENT',
  'ACTIVATION_FAILED',
  'SUPABASE_WRITE_FAILED',
  'JOONAPAY_UNAVAILABLE',
  'INTERNAL_SIGNATURE_REJECTED',
]);

/** Ecrit l'evenement dans les journaux du serveur (une ligne JSON). */
export function journaliser(evenement, details = {}) {
  const niveau = ALERTES.has(evenement) ? 'ALERTE' : /FAILED|INVALID|ERROR|REFUS/.test(evenement) ? 'AVERTISSEMENT' : 'INFO';
  const ligne = {
    ts: new Date().toISOString(),
    service: process.env.TIMORA_SERVICE_NAME || 'timora-payments',
    niveau,
    evenement,
    ...nettoyer(details),
  };
  const sortie = niveau === 'ALERTE' ? console.error : niveau === 'AVERTISSEMENT' ? console.warn : console.log;
  sortie(JSON.stringify(ligne));
}

/**
 * Trace lisible « [BILLING] … » pour suivre un paiement pendant le
 * developpement. Muette en production Vercel (VERCEL_ENV=production).
 * Memes regles : aucune cle, aucun secret, aucun jeton.
 */
export function traceDev(message, details = {}) {
  if (process.env.VERCEL_ENV === 'production') return;
  const propre = nettoyer(details);
  console.log(`[BILLING] ${message}`, Object.keys(propre).length ? JSON.stringify(propre) : '');
}
