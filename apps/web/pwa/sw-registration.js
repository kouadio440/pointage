/* =============================================================================
 *  TIMORA — ENREGISTREMENT DU SERVICE WORKER ET MISES A JOUR
 * =============================================================================
 *
 *  ENREGISTREMENT
 *  --------------
 *  Apres le chargement complet de la page : le service worker ne retarde
 *  jamais le premier affichage. Sans prise en charge (navigateur ancien,
 *  contexte non securise, navigation privee restreinte), rien ne se passe et
 *  le site fonctionne exactement comme avant.
 *
 *  MISE A JOUR SANS RECHARGEMENT IMPOSE
 *  ------------------------------------
 *  Une nouvelle version du service worker s'installe en arriere-plan puis
 *  ATTEND (sw.js n'appelle pas skipWaiting de lui-meme). La page l'annonce
 *  par le bandeau existant de app.js (« Une nouvelle version de Timora est
 *  disponible »). Ce n'est qu'au clic sur « Mettre à jour », et si aucun
 *  pointage ni formulaire n'est en cours, que la nouvelle version est activee
 *  et la page rechargee.
 *
 *  Un autre onglet qui applique la mise a jour ne recharge PAS celui-ci : seul
 *  l'onglet qui l'a demandee se recharge.
 * ========================================================================== */

(function () {
  'use strict';

  var CLE_MAJ_DEMANDEE = 'timora_pwa_maj_demandee';
  var VERIFICATION_PERIODIQUE_MS = 60 * 60 * 1000;

  var enregistrement = null;
  var miseAJourDemandee = false;
  var annoncee = false;

  function suivre(nom, donnees) {
    var charge = Object.assign({ event: nom }, donnees || {});
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(charge);
      window.dispatchEvent(new CustomEvent('timora:analytics', { detail: charge }));
    } catch (err) {
      /* La mesure ne doit jamais bloquer l'application. */
    }
  }

  function supporte() {
    return 'serviceWorker' in navigator && window.isSecureContext === true;
  }

  /** Une nouvelle version est-elle installee et en attente d'activation ? */
  function versionEnAttente() {
    return !!(enregistrement && enregistrement.waiting && navigator.serviceWorker.controller);
  }

  function annoncer() {
    if (annoncee) return;
    annoncee = true;
    if (typeof window.annoncerMiseAJourDisponible === 'function') {
      window.annoncerMiseAJourDisponible('service-worker');
    } else {
      suivre('pwa_update_available', { source: 'service-worker' });
    }
  }

  function surveiller(reg) {
    // Version deja en attente (installee lors d'une visite precedente).
    if (reg.waiting && navigator.serviceWorker.controller) annoncer();

    reg.addEventListener('updatefound', function () {
      var nouvelle = reg.installing;
      if (!nouvelle) return;
      nouvelle.addEventListener('statechange', function () {
        // Sans controleur, c'est la toute premiere installation : rien a annoncer.
        if (nouvelle.state === 'installed' && navigator.serviceWorker.controller) annoncer();
      });
    });
  }

  /**
   * Active la version en attente. Renvoie faux s'il n'y en a pas : l'appelant
   * recharge alors simplement la page (nouvelle version du site sans
   * changement du service worker).
   */
  function appliquerMiseAJour() {
    if (!versionEnAttente()) return false;
    miseAJourDemandee = true;
    try { sessionStorage.setItem(CLE_MAJ_DEMANDEE, '1'); } catch (err) { /* sans consequence */ }
    enregistrement.waiting.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }

  function signalerMiseAJourTerminee() {
    try {
      if (sessionStorage.getItem(CLE_MAJ_DEMANDEE)) {
        sessionStorage.removeItem(CLE_MAJ_DEMANDEE);
        suivre('pwa_update_completed', {});
      }
    } catch (err) {
      /* Stockage indisponible : l'evenement est simplement perdu. */
    }
  }

  function demarrer() {
    signalerMiseAJourTerminee();
    if (!supporte()) return;

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (miseAJourDemandee) window.location.reload();
    });

    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(function (reg) {
        enregistrement = reg;
        surveiller(reg);

        // Une application installee reste ouverte des jours : on verifie au
        // retour sur l'ecran et toutes les heures, pas seulement au lancement.
        var verifier = function () { reg.update().catch(function () { /* hors ligne */ }); };
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') verifier();
        });
        window.setInterval(verifier, VERIFICATION_PERIODIQUE_MS);
      })
      .catch(function (err) {
        console.warn('[PWA] Service worker non enregistré :', err);
      });
  }

  window.timoraPwa = Object.freeze({
    versionEnAttente: versionEnAttente,
    appliquerMiseAJour: appliquerMiseAJour,
  });

  if (document.readyState === 'complete') {
    demarrer();
  } else {
    window.addEventListener('load', demarrer);
  }
})();
