/* =============================================================================
 *  TIMORA — CATALOGUE DES FORMULES (source unique des prix)
 * =============================================================================
 *
 *  Ce fichier est LA source de verite des formules, de leurs prix et de leurs
 *  limites :
 *
 *    - la page d'accueil et l'ecran d'activation l'affichent immediatement,
 *      sans appel reseau (script charge avant app.js) ;
 *    - le serveur de paiement (server/facturation/catalogue.mjs) l'importe et
 *      refuse tout paiement dont le montant en base ne lui correspond pas ;
 *    - les migrations 031 (tarifs) et 033 (limites) en tirent les valeurs
 *      inserees dans platform_plans, que la base utilise pour calculer le
 *      montant facture et refuser un collaborateur, un site ou un
 *      administrateur de trop.
 *
 *  Le navigateur n'est JAMAIS la source du montant facture : il n'envoie que
 *  le code de la formule ; le serveur recalcule le montant a partir de ce code.
 *
 *  LIMITES (regle unique, controlee par la base) :
 *    - maxEmployes  : collaborateurs ACTIFS de role employe ou manager ;
 *                     les demandes en attente ne comptent pas ;
 *    - maxSites     : sites (zones de pointage) ACTIFS ;
 *    - maxAdmins    : proprietaire COMPRIS, plus les administrateurs.
 *  null = defini par contrat (formule Entreprise).
 *
 *  Changer un prix ou une limite : modifier ce fichier, puis appliquer la meme
 *  valeur dans platform_plans (migration). `node scripts/check-billing-catalogue.mjs`
 *  verifie que les deux concordent.
 *
 *  Fonctionne dans le navigateur (window.CATALOGUE_TIMORA) et dans Node
 *  (module.exports), sans outil de construction.
 * ========================================================================== */

(function (racine, fabrique) {
  const catalogue = fabrique();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = catalogue;
  } else {
    racine.CATALOGUE_TIMORA = catalogue;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const formule = (code, nom, mensuel, annuel, maxEmployes, maxSites, maxAdmins) => Object.freeze({
    code,
    nom,
    // Montants en francs CFA (XOF), entiers : le XOF n'a pas de decimales.
    mensuel,
    annuel,
    // Limites (voir l'en-tete) ; null = definies par contrat (sur devis).
    maxEmployes,
    maxSites,
    maxAdmins,
    // Souscription en ligne possible (sinon : sur devis, activation manuelle).
    enLigne: mensuel !== null,
  });

  return Object.freeze({
    devise: 'XOF',
    // L'annuel vaut 10 mois : « 2 mois offerts ».
    moisOffertsAnnuel: 2,
    formules: Object.freeze([
      formule('essentiel', 'Essentiel', 15000, 150000, 10, 1, 1),
      formule('business', 'Business', 35000, 350000, 30, 3, 3),
      formule('pro', 'Pro', 75000, 750000, 100, 10, 10),
      formule('entreprise', 'Entreprise', null, null, null, null, null),
    ]),
  });
});
