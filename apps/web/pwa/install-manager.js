/* =============================================================================
 *  TIMORA — GESTIONNAIRE D'INSTALLATION
 * =============================================================================
 *
 *  Timora s'installe DEPUIS LE NAVIGATEUR (application web progressive). Ce
 *  n'est ni une application de l'App Store ni une application Google Play, et
 *  rien ici ne le pretend.
 *
 *  DETECTION PAR CAPACITES, PAS PAR NOM DE NAVIGATEUR
 *  --------------------------------------------------
 *  L'etat d'installation est deduit de ce que le navigateur SAIT faire :
 *
 *    - affichage en mode application (`display-mode: standalone`, ou
 *      `navigator.standalone` sur iOS)            -> ALREADY_INSTALLED
 *    - evenement `beforeinstallprompt` recu       -> INSTALLABLE
 *    - WebKit mobile d'Apple, qui n'emet jamais cet evenement et n'installe
 *      que par le menu Partager                   -> IOS_MANUAL_INSTALL
 *    - navigateur capable de l'emettre, mais qui ne l'a pas (encore) fait
 *                                                  -> UNKNOWN
 *    - aucun parcours d'installation              -> NOT_SUPPORTED
 *
 *  L'evenement `beforeinstallprompt` est capture des le <head> (voir
 *  index.html) : il ne peut donc pas etre manque, meme s'il arrivait avant
 *  l'execution de ce fichier.
 *
 *  AUCUNE INVITE AUTOMATIQUE
 *  -------------------------
 *  L'invite systeme ne s'ouvre qu'au clic sur un bouton « Installer Timora ».
 *  Aucune autorisation (camera, position, notifications) n'est demandee ici.
 * ========================================================================== */

(function () {
  'use strict';

  var ETATS = Object.freeze({
    INSTALLABLE: 'INSTALLABLE',
    IOS_MANUAL_INSTALL: 'IOS_MANUAL_INSTALL',
    ALREADY_INSTALLED: 'ALREADY_INSTALLED',
    NOT_SUPPORTED: 'NOT_SUPPORTED',
    UNKNOWN: 'UNKNOWN',
  });

  var CLE_INSTALLEE = 'timora_pwa_installee';
  var CLE_OUVERTURE_SIGNALEE = 'timora_pwa_ouverture_signalee';

  var vuesSignalees = false;
  var fermetureFeuille = null;

  // ---------------------------------------------------------------------------
  //  MESURE — meme canal que le reste du site (dataLayer + CustomEvent)
  // ---------------------------------------------------------------------------

  function suivre(nom, donnees) {
    var charge = Object.assign({ event: nom }, donnees || {});
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(charge);
      window.dispatchEvent(new CustomEvent('timora:analytics', { detail: charge }));
    } catch (err) {
      /* La mesure ne doit jamais bloquer l'installation. */
    }
  }

  // ---------------------------------------------------------------------------
  //  DETECTION
  // ---------------------------------------------------------------------------

  function correspond(requete) {
    try {
      return !!(window.matchMedia && window.matchMedia(requete).matches);
    } catch (err) {
      return false;
    }
  }

  /** Timora est-il affiche comme une application installee ? */
  function estEnModeApplication() {
    return correspond('(display-mode: standalone)')
      || correspond('(display-mode: fullscreen)')
      || correspond('(display-mode: window-controls-overlay)')
      || window.navigator.standalone === true;
  }

  /**
   * WebKit mobile d'Apple (iPhone, iPad).
   *
   * `navigator.standalone` n'existe que dans WebKit sur iOS et iPadOS ; le
   * nombre de points de contact exclut Safari sur Mac. L'iPad se presente comme
   * un Mac dans sa chaine d'agent : cette detection le reconnait quand meme.
   */
  function estWebKitMobileApple() {
    return typeof window.navigator.standalone === 'boolean'
      && (window.navigator.maxTouchPoints || 0) > 1;
  }

  function getPWAInstallState() {
    if (estEnModeApplication()) return ETATS.ALREADY_INSTALLED;
    if (window.__timoraInstallPrompt) return ETATS.INSTALLABLE;
    if (estWebKitMobileApple()) return ETATS.IOS_MANUAL_INSTALL;
    if ('onbeforeinstallprompt' in window) return ETATS.UNKNOWN;
    return ETATS.NOT_SUPPORTED;
  }

  // ---------------------------------------------------------------------------
  //  BOUTONS « INSTALLER TIMORA »
  // ---------------------------------------------------------------------------

  function boutons() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-pwa-install]'));
  }

  /** Montre les boutons seulement quand un parcours d'installation existe reellement. */
  function rafraichir() {
    var etat = getPWAInstallState();
    var visible = etat === ETATS.INSTALLABLE || etat === ETATS.IOS_MANUAL_INSTALL;

    document.documentElement.classList.toggle('pwa-standalone', etat === ETATS.ALREADY_INSTALLED);

    boutons().forEach(function (bouton) {
      bouton.hidden = !visible;
    });

    if (visible) observerVisibilite();
    return etat;
  }

  /** `pwa_install_cta_viewed` : une fois par page, au premier bouton reellement vu. */
  function observerVisibilite() {
    if (vuesSignalees) return;

    if (!('IntersectionObserver' in window)) {
      vuesSignalees = true;
      suivre('pwa_install_cta_viewed', { etat: getPWAInstallState() });
      return;
    }

    var observateur = new IntersectionObserver(function (entrees) {
      entrees.forEach(function (entree) {
        if (!entree.isIntersecting || vuesSignalees) return;
        vuesSignalees = true;
        suivre('pwa_install_cta_viewed', {
          emplacement: entree.target.getAttribute('data-pwa-install'),
          etat: getPWAInstallState(),
        });
        observateur.disconnect();
      });
    }, { threshold: 0.5 });

    boutons().forEach(function (bouton) {
      if (!bouton.hidden) observateur.observe(bouton);
    });
  }

  function notifier(titre, message) {
    if (typeof window.showToast === 'function') window.showToast(titre, message, 'success', 4000);
  }

  // ---------------------------------------------------------------------------
  //  INSTALLATION
  // ---------------------------------------------------------------------------

  async function installer(emplacement) {
    var etat = getPWAInstallState();
    suivre('pwa_install_cta_clicked', { emplacement: emplacement, etat: etat });

    if (etat === ETATS.IOS_MANUAL_INSTALL) {
      ouvrirInstructionsIos();
      return;
    }

    if (etat !== ETATS.INSTALLABLE) return;

    // L'evenement ne sert qu'une fois : on le retire AVANT de l'utiliser, pour
    // qu'un second clic rapide ne tente pas de le reutiliser.
    var invite = window.__timoraInstallPrompt;
    window.__timoraInstallPrompt = null;
    rafraichir();

    try {
      await invite.prompt();
      suivre('pwa_install_prompt_shown', { emplacement: emplacement });

      var choix = await invite.userChoice;
      if (choix && choix.outcome === 'accepted') {
        suivre('pwa_install_accepted', { emplacement: emplacement });
      } else {
        // Refus : les boutons restent masques jusqu'a ce que le navigateur
        // propose de nouveau l'installation. Rien n'est relance d'office.
        suivre('pwa_install_dismissed', { emplacement: emplacement });
      }
    } catch (err) {
      console.error('[PWA] Invite d\'installation indisponible :', err);
    }
  }

  // ---------------------------------------------------------------------------
  //  INSTRUCTIONS iPhone / iPad
  // ---------------------------------------------------------------------------

  function elementsFeuille() {
    return {
      racine: document.getElementById('pwa-ios-sheet'),
      titre: document.getElementById('pwa-ios-sheet-titre'),
      panneau: document.getElementById('pwa-ios-sheet-panneau'),
    };
  }

  function focusables(conteneur) {
    return Array.prototype.slice.call(conteneur.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
  }

  function ouvrirInstructionsIos() {
    var el = elementsFeuille();
    if (!el.racine || !el.panneau) return;

    // L'iPad n'a pas la meme barre d'outils : le titre le nomme correctement.
    // Taille d'ecran plutot que chaine d'agent (l'iPad se presente comme un Mac).
    var cote = Math.min(window.screen.width || 0, window.screen.height || 0);
    if (el.titre) {
      el.titre.textContent = cote >= 700
        ? 'Installer Timora sur votre iPad'
        : 'Installer Timora sur votre iPhone';
    }

    var precedent = document.activeElement;
    el.racine.hidden = false;
    document.documentElement.classList.add('pwa-sheet-ouverte');

    // Classe posee au cadre suivant : la transition d'entree a lieu.
    window.requestAnimationFrame(function () {
      el.racine.classList.add('est-ouverte');
      var cibles = focusables(el.panneau);
      if (cibles.length) cibles[cibles.length - 1].focus();
    });

    function surTouche(evenement) {
      if (evenement.key === 'Escape') {
        evenement.preventDefault();
        fermer();
        return;
      }
      // Le focus reste dans la feuille tant qu'elle est ouverte.
      if (evenement.key !== 'Tab') return;
      var cibles = focusables(el.panneau);
      if (!cibles.length) return;
      var premier = cibles[0];
      var dernier = cibles[cibles.length - 1];
      if (evenement.shiftKey && document.activeElement === premier) {
        evenement.preventDefault();
        dernier.focus();
      } else if (!evenement.shiftKey && document.activeElement === dernier) {
        evenement.preventDefault();
        premier.focus();
      }
    }

    // Fermeture par le fond seulement si l'appui COMMENCE et FINIT dessus : un
    // glissement du doigt parti de la feuille ne la ferme pas par accident.
    var appuiSurFond = false;
    function surAppui(evenement) { appuiSurFond = evenement.target === el.racine; }
    function surRelache(evenement) {
      if (appuiSurFond && evenement.target === el.racine) fermer();
      appuiSurFond = false;
    }

    function fermer() {
      document.removeEventListener('keydown', surTouche, true);
      el.racine.removeEventListener('pointerdown', surAppui);
      el.racine.removeEventListener('pointerup', surRelache);
      el.racine.classList.remove('est-ouverte');
      document.documentElement.classList.remove('pwa-sheet-ouverte');
      fermetureFeuille = null;

      var reduit = correspond('(prefers-reduced-motion: reduce)');
      window.setTimeout(function () { el.racine.hidden = true; }, reduit ? 0 : 220);

      if (precedent && typeof precedent.focus === 'function') precedent.focus();
    }

    document.addEventListener('keydown', surTouche, true);
    el.racine.addEventListener('pointerdown', surAppui);
    el.racine.addEventListener('pointerup', surRelache);
    fermetureFeuille = fermer;

    suivre('pwa_ios_instructions_opened', {});
  }

  function fermerInstructionsIos() {
    if (fermetureFeuille) fermetureFeuille();
  }

  // ---------------------------------------------------------------------------
  //  EVENEMENTS
  // ---------------------------------------------------------------------------

  function demarrer() {
    // Delegation : un seul ecouteur pour tous les boutons, presents ou futurs.
    document.addEventListener('click', function (evenement) {
      var bouton = evenement.target.closest && evenement.target.closest('[data-pwa-install]');
      if (bouton) {
        evenement.preventDefault();
        if (typeof window.closeMobileMenu === 'function') window.closeMobileMenu();
        installer(bouton.getAttribute('data-pwa-install'));
        return;
      }
      if (evenement.target.closest && evenement.target.closest('[data-pwa-sheet-fermer]')) {
        evenement.preventDefault();
        fermerInstructionsIos();
      }
    });

    // Invite capturee dans le <head>, avant ou apres le chargement de ce fichier.
    window.addEventListener('timora:installprompt', rafraichir);

    window.addEventListener('appinstalled', function () {
      window.__timoraInstallPrompt = null;
      try {
        localStorage.setItem(CLE_INSTALLEE, new Date().toISOString());
      } catch (err) {
        /* Stockage indisponible : sans consequence. */
      }
      rafraichir();
      boutons().forEach(function (bouton) { bouton.hidden = true; });
      notifier('Timora est installé ✓', 'Retrouvez Timora sur votre écran d\'accueil.');
      suivre('pwa_installed', {});
    });

    // Bascule vers ou depuis le mode application sans rechargement (desktop).
    try {
      var media = window.matchMedia('(display-mode: standalone)');
      if (media && typeof media.addEventListener === 'function') media.addEventListener('change', rafraichir);
    } catch (err) {
      /* Navigateur ancien : l'etat initial suffit. */
    }

    var etat = rafraichir();

    if (etat === ETATS.ALREADY_INSTALLED) {
      try {
        if (!sessionStorage.getItem(CLE_OUVERTURE_SIGNALEE)) {
          sessionStorage.setItem(CLE_OUVERTURE_SIGNALEE, '1');
          suivre('pwa_opened_standalone', {});
        }
      } catch (err) {
        suivre('pwa_opened_standalone', {});
      }
    }
  }

  // Seule surface publique : utile au diagnostic et aux tests.
  window.timoraInstallation = Object.freeze({
    ETATS: ETATS,
    getPWAInstallState: getPWAInstallState,
    installer: installer,
    ouvrirInstructionsIos: ouvrirInstructionsIos,
    fermerInstructionsIos: fermerInstructionsIos,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', demarrer);
  } else {
    demarrer();
  }
})();
