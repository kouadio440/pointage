/* =============================================================================
 *  TIMORA — CATALOGUE DES FORMULES (source unique des prix)
 * =============================================================================
 *
 *  Ce fichier est LA source de verite des formules et de leurs prix :
 *
 *    - la page d'accueil et l'ecran d'activation l'affichent immediatement,
 *      sans appel reseau (script charge avant app.js) ;
 *    - le serveur de paiement (server/facturation/catalogue.mjs) l'importe et
 *      refuse tout paiement dont le montant en base ne lui correspond pas ;
 *    - la migration 031 en tire les tarifs inseres dans platform_plans, que la
 *      base utilise pour calculer le montant facture.
 *
 *  Le navigateur n'est JAMAIS la source du montant facture : il n'envoie que
 *  le code de la formule ; le serveur recalcule le montant a partir de ce code.
 *
 *  Changer un prix : modifier ce fichier, puis appliquer le meme montant dans
 *  platform_plans (migration). `node scripts/check-billing-catalogue.mjs`
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
  const formule = (code, nom, mensuel, annuel, maxEmployes) => Object.freeze({
    code,
    nom,
    // Montants en francs CFA (XOF), entiers : le XOF n'a pas de decimales.
    mensuel,
    annuel,
    // Effectif maximal couvert ; null = sans limite (formule sur devis).
    maxEmployes,
    // Souscription en ligne possible (sinon : sur devis, activation manuelle).
    enLigne: mensuel !== null,
  });

  return Object.freeze({
    devise: 'XOF',
    // L'annuel vaut 10 mois : « 2 mois offerts ».
    moisOffertsAnnuel: 2,
    formules: Object.freeze([
      formule('essentiel', 'Essentiel', 15000, 150000, 10),
      formule('business', 'Business', 35000, 350000, 30),
      formule('pro', 'Pro', 75000, 750000, 100),
      formule('entreprise', 'Entreprise', null, null, null),
    ]),
  });
});
