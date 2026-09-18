// Catalogue des formules, cote serveur : le MEME fichier que celui affiche par
// la page d'accueil (apps/web/billing/catalogue.js). Le montant d'un paiement
// est recalcule ici a partir du code de la formule ; celui envoye par un
// navigateur n'est jamais lu.

import catalogue from '../../apps/web/billing/catalogue.js';

export const DEVISE = catalogue.devise;

/** Montant attendu pour une formule et une periode, ou null si non souscriptible en ligne. */
export function montantCatalogue(code, periode) {
  const f = catalogue.formules.find((x) => x.code === code);
  if (!f || !f.enLigne) return null;
  return periode === 'ANNUAL' ? f.annuel : f.mensuel;
}

export function formuleCatalogue(code) {
  return catalogue.formules.find((x) => x.code === code) || null;
}
