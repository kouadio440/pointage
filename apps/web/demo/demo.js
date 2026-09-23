/* =============================================================================
 *  TIMORA — DEMONSTRATION DE LA PAGE D'ACCUEIL (100 % SIMULEE)
 * =============================================================================
 *
 *  Montre en moins de vingt secondes ce que fait Timora : un collaborateur
 *  pointe depuis son telephone, puis le responsable RH voit le resultat.
 *
 *  CE QUE CETTE DEMONSTRATION NE FAIT PAS, VOLONTAIREMENT
 *  -----------------------------------------------------
 *    - aucune camera : pas de getUserMedia, aucune demande d'autorisation ;
 *    - aucune detection faciale : ni face-api, ni FaceDetector, ni modele —
 *      la page d'accueil ne telecharge donc rien de lourd ;
 *    - aucune position reelle : navigator.geolocation n'est jamais appele ;
 *    - aucun compte, aucun appel au serveur, aucune ecriture en base.
 *
 *  Le visage affiche est un AVATAR dessine en SVG : il ne represente
 *  personne, ne pese presque rien et s'affiche instantanement.
 *
 *  Tout l'etat vit dans l'objet `demo` ci-dessous, en memoire. Fermer la
 *  modale ou recharger la page efface tout.
 *
 *  La vraie reconnaissance faciale de Timora vit dans l'application
 *  authentifiee (app.js) et n'a aucun rapport avec ce fichier.
 *
 *  Point d'entree : openPunchModal() (nom conserve : les boutons de la page
 *  d'accueil l'appellent deja).
 * ========================================================================== */

const SCENARIOS_DEMO = {
  a_lheure: {
    libelle: "À l'heure",
    icone: 'check-circle-2',
    heure: '08:03',
    dansLaZone: true,
    retard: 0,
    distance: 42,
    cockpit: { presents: 42, retards: 3, absents: 2 },
  },
  en_retard: {
    libelle: 'En retard',
    icone: 'alarm-clock',
    heure: '08:27',
    dansLaZone: true,
    retard: 27,
    distance: 42,
    cockpit: { presents: 42, retards: 4, absents: 2 },
  },
  hors_zone: {
    libelle: 'Hors zone',
    icone: 'map-pin-off',
    heure: '08:27',
    dansLaZone: false,
    retard: 0,
    distance: 1240,
    cockpit: { presents: 41, retards: 3, absents: 3 },
  },
};

const EFFECTIF_DEMO = 48;
const SITE_DEMO = 'Bureau principal';
const RAYON_DEMO = 150;           // metres, zone autorisee de l'exemple
const EMPLOYE_DEMO = 'Marie K.';

/* -----------------------------------------------------------------------------
 *  RYTHME
 * -----------------------------------------------------------------------------
 *  Tout est simule : plus rien ne justifie une attente. Chaque etat reste
 *  affiche juste assez longtemps pour etre lu, pas une milliseconde de plus.
 *  Etape faciale : 400 + 300 + 250 + 300 = 1 250 ms.
 * -------------------------------------------------------------------------- */
const RYTHME_SCAN = { recherche: 400, detecte: 300, analyse: 250, valide: 300 };
const RYTHME_POINTAGE = { position: 600, horaire: 450, enregistrement: 450 };

const MENTION_SIMULATION =
  'Simulation de démonstration — aucune donnée biométrique ni position réelle n\'est collectée.';

const demo = {
  ecran: 'intro',       // intro -> scan -> pointage -> cockpit -> fin
  scenario: 'a_lheure',
  phase: 'recherche',   // recherche -> detecte -> analyse -> valide
  etape: 0,             // 0 a 3 pendant le pointage
  refuse: false,
  minuteurs: [],
  dejaDemarree: false,
  focusAvant: null,
};

function suivreDemo(nom, donnees = {}) {
  // Suivi marketing uniquement : un nom d'etape et le scenario choisi.
  // Jamais de contenu de la demonstration.
  if (typeof suivreTarifs === 'function') suivreTarifs(nom, donnees);
}

function mouvementReduit() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function annulerMinuteursDemo() {
  demo.minuteurs.forEach((m) => clearTimeout(m));
  demo.minuteurs = [];
}

function plusTardDemo(fn, ms) {
  demo.minuteurs.push(setTimeout(fn, mouvementReduit() ? Math.min(ms, 200) : ms));
}

// -----------------------------------------------------------------------------
//  OUVERTURE / FERMETURE
// -----------------------------------------------------------------------------

function openPunchModal() {
  const modale = document.getElementById('modal-punch');
  if (!modale) return;
  demo.focusAvant = document.activeElement;
  annulerMinuteursDemo();
  demo.ecran = 'intro';
  demo.phase = 'recherche';
  demo.etape = 0;
  demo.refuse = false;
  modale.hidden = false;
  document.documentElement.classList.add('demo-ouverte');
  rendreDemo();
}

function closePunchModal() {
  const modale = document.getElementById('modal-punch');
  annulerMinuteursDemo();
  if (!modale || modale.hidden) return;
  modale.hidden = true;
  document.documentElement.classList.remove('demo-ouverte');
  if (demo.focusAvant && typeof demo.focusAvant.focus === 'function') demo.focusAvant.focus();
}

// -----------------------------------------------------------------------------
//  DEROULE
// -----------------------------------------------------------------------------

/** Etape faciale simulee : 1,25 s au total, sans aucun calcul. */
function lancerScanDemo() {
  if (!demo.dejaDemarree) {
    demo.dejaDemarree = true;
    suivreDemo('homepage_demo_started', { scenario: demo.scenario });
  }
  annulerMinuteursDemo();
  demo.ecran = 'scan';
  demo.phase = 'recherche';
  rendreDemo();

  const suite = [
    ['detecte', RYTHME_SCAN.recherche],
    ['analyse', RYTHME_SCAN.recherche + RYTHME_SCAN.detecte],
    ['valide', RYTHME_SCAN.recherche + RYTHME_SCAN.detecte + RYTHME_SCAN.analyse],
  ];
  // Seule la surcouche change : l'ecran n'est pas reconstruit, l'animation
  // du cadre reste continue.
  suite.forEach(([phase, delai]) => plusTardDemo(() => {
    if (demo.ecran !== 'scan') return;
    demo.phase = phase;
    majScanDemo();
  }, delai));

  plusTardDemo(() => {
    if (demo.ecran !== 'scan') return;
    suivreDemo('demo_face_step_validated', { scenario: demo.scenario });
    lancerPointageDemo();
  }, RYTHME_SCAN.recherche + RYTHME_SCAN.detecte + RYTHME_SCAN.analyse + RYTHME_SCAN.valide);
}

function lancerPointageDemo() {
  const s = SCENARIOS_DEMO[demo.scenario];
  annulerMinuteursDemo();
  demo.ecran = 'pointage';
  demo.etape = 1;
  demo.refuse = false;
  rendreDemo();

  const t = RYTHME_POINTAGE;
  // Etape 1 : position. Etape 2 : horaire. Etape 3 : enregistrement.
  plusTardDemo(() => {
    if (!s.dansLaZone) {
      demo.refuse = true;
      demo.etape = 2;
      rendreDemo();
      return;
    }
    demo.etape = 2;
    rendreDemo();
  }, t.position);
  if (s.dansLaZone) {
    plusTardDemo(() => { demo.etape = 3; rendreDemo(); }, t.position + t.horaire);
    plusTardDemo(() => { demo.etape = 4; rendreDemo(); }, t.position + t.horaire + t.enregistrement);
  }
}

function choisirScenarioDemo(code) {
  if (!SCENARIOS_DEMO[code] || code === demo.scenario) return;
  demo.scenario = code;
  suivreDemo('demo_scenario_selected', { scenario: code });
  rendreDemo();
}

function allerAuCockpitDemo() {
  demo.ecran = 'cockpit';
  rendreDemo();
}

function terminerDemo() {
  demo.ecran = 'fin';
  suivreDemo('homepage_demo_completed', { scenario: demo.scenario });
  rendreDemo();
}

function recommencerDemo() {
  // Reinitialise UNIQUEMENT l'etat local de la demonstration.
  annulerMinuteursDemo();
  demo.ecran = 'intro';
  demo.phase = 'recherche';
  demo.etape = 0;
  demo.refuse = false;
  rendreDemo();
}

// -----------------------------------------------------------------------------
//  RENDU
// -----------------------------------------------------------------------------

const echapDemo = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));

const TEXTES_SCAN = {
  recherche: 'Recherche du visage…',
  detecte: 'Visage détecté ✓',
  analyse: 'Analyse…',
  valide: 'Contrôle facial simulé ✓',
};
const ETAT_SCAN = { recherche: 'attente', detecte: 'ok', analyse: 'attente', valide: 'ok' };
const AVANCEMENT_SCAN = { recherche: 22, detecte: 60, analyse: 82, valide: 100 };

/**
 * Avatar dessine en SVG : environ 1 Ko, net sur tous les ecrans, affiche sans
 * aucune requete reseau. Il ne represente personne.
 */
function avatarDemo() {
  return `
    <svg class="demo-avatar-svg" viewBox="0 0 120 150" role="img"
         aria-label="Avatar de démonstration, dessin générique">
      <defs>
        <linearGradient id="demo-degrade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#F59E0B" stop-opacity="0.30" />
          <stop offset="100%" stop-color="#10B981" stop-opacity="0.16" />
        </linearGradient>
      </defs>
      <rect width="120" height="150" fill="url(#demo-degrade)" />
      <circle cx="60" cy="56" r="27" fill="#0b0d13" opacity="0.55" />
      <circle cx="60" cy="56" r="27" fill="none" stroke="#FBBF24" stroke-width="1.5" opacity="0.8" />
      <circle cx="51" cy="52" r="3" fill="#FBBF24" />
      <circle cx="69" cy="52" r="3" fill="#FBBF24" />
      <path d="M50 66 q10 8 20 0" fill="none" stroke="#FBBF24" stroke-width="2" stroke-linecap="round" />
      <path d="M22 150 q0-34 38-34 t38 34 z" fill="#0b0d13" opacity="0.55" />
      <path d="M22 150 q0-34 38-34 t38 34" fill="none" stroke="#10B981" stroke-width="1.5" opacity="0.6" />
    </svg>`;
}

/** Met a jour la surcouche du scan sans reconstruire l'ecran. */
function majScanDemo() {
  const cadre = document.getElementById('demo-cadre');
  if (cadre) cadre.dataset.phase = demo.phase;
  const statut = document.getElementById('demo-scan-statut');
  if (statut) {
    statut.textContent = TEXTES_SCAN[demo.phase] || '';
    statut.dataset.etat = ETAT_SCAN[demo.phase] || 'attente';
  }
  const barre = document.getElementById('demo-scan-progres');
  if (barre) barre.style.width = `${AVANCEMENT_SCAN[demo.phase] || 0}%`;
}

function ligneEtapeDemo(numero, enCours, fait, ko) {
  const s = SCENARIOS_DEMO[demo.scenario];
  const etapes = {
    1: ['Vérification de la position…', 'Zone autorisée ✓', 'Zone non autorisée'],
    2: ["Contrôle de l'horaire…", s.retard ? `Retard — ${s.retard} min` : "Arrivée à l'heure", null],
    3: ['Enregistrement du pointage…', 'Pointage enregistré ✓', null],
  };
  const [attente, succes, echec] = etapes[numero];
  let etat = 'a-venir';
  if (ko) etat = 'ko';
  else if (fait) etat = 'ok';
  else if (enCours) etat = 'en-cours';

  const icone = etat === 'ok' ? '<i data-lucide="check" aria-hidden="true"></i>'
    : etat === 'ko' ? '<i data-lucide="x" aria-hidden="true"></i>'
      : etat === 'en-cours' ? '<span class="demo-roue" aria-hidden="true"></span>'
        : `<span aria-hidden="true">${numero}</span>`;
  const texte = etat === 'ok' ? succes : etat === 'ko' ? echec : attente;

  let detail = '';
  if (numero === 1 && (etat === 'ok' || etat === 'ko')) {
    detail = `<span class="demo-etape__detail">${echapDemo(SITE_DEMO)} · Distance ${s.distance} m · Zone autorisée ${RAYON_DEMO} m</span>`;
  } else if (numero === 2 && etat === 'ok') {
    detail = `<span class="demo-etape__detail">Arrivée — ${echapDemo(s.heure)}</span>`;
  }
  return `
    <li class="demo-etape is-${etat}">
      <span class="demo-etape__puce">${icone}</span>
      <span class="demo-etape__texte"><strong>${texte}</strong>${detail}</span>
    </li>`;
}

function ecranIntroDemo() {
  const puces = Object.entries(SCENARIOS_DEMO).map(([code, s]) => `
    <label class="demo-scenario">
      <input type="radio" name="demo-scenario" value="${code}" ${demo.scenario === code ? 'checked' : ''} data-demo-scenario="${code}" />
      <span><i data-lucide="${s.icone}" aria-hidden="true"></i>${echapDemo(s.libelle)}</span>
    </label>`).join('');

  return `
    <div class="demo-tete">
      <h2 id="demo-titre" class="demo-titre" tabindex="-1">Testez Timora maintenant</h2>
      <p class="demo-sous-titre">Suivez un pointage complet : contrôle facial, position, puis résultat côté RH.</p>
    </div>

    <fieldset class="demo-scenarios">
      <legend>Choisissez une situation</legend>
      <div class="demo-scenarios__liste">${puces}</div>
    </fieldset>

    <div class="demo-telephone">
      <div class="demo-telephone__entete">
        <span class="demo-avatar" aria-hidden="true">MK</span>
        <span><strong>${echapDemo(EMPLOYE_DEMO)}</strong><small>${echapDemo(SITE_DEMO)} — Abidjan</small></span>
      </div>
      <button type="button" class="demo-bouton-pointer" data-demo-action="pointer">
        <i data-lucide="scan-face" aria-hidden="true"></i>
        Démarrer le pointage
      </button>
    </div>

    <p class="demo-note">
      <i data-lucide="shield-check" aria-hidden="true"></i>
      ${MENTION_SIMULATION}
    </p>`;
}

function ecranScanDemo() {
  return `
    <div class="demo-tete">
      <h2 id="demo-titre" class="demo-titre" tabindex="-1">Contrôle facial</h2>
      <p class="demo-sous-titre">Simulation — voici ce que voit le collaborateur sur son téléphone.</p>
    </div>

    <div id="demo-cadre" class="demo-cadre" data-phase="${demo.phase}">
      <div class="demo-avatar-simule" aria-hidden="true">${avatarDemo()}</div>
      <div class="demo-reticule" aria-hidden="true">
        <span class="demo-coin demo-coin--hg"></span>
        <span class="demo-coin demo-coin--hd"></span>
        <span class="demo-coin demo-coin--bg"></span>
        <span class="demo-coin demo-coin--bd"></span>
        <span class="demo-scan"></span>
      </div>
      <div class="demo-boite" aria-hidden="true">
        <span class="demo-point demo-point--1"></span>
        <span class="demo-point demo-point--2"></span>
        <span class="demo-point demo-point--3"></span>
        <span class="demo-point demo-point--4"></span>
      </div>
    </div>

    <p id="demo-scan-statut" class="demo-face-statut" data-etat="${ETAT_SCAN[demo.phase]}" role="status">
      ${echapDemo(TEXTES_SCAN[demo.phase] || '')}
    </p>
    <div class="demo-progres" aria-hidden="true"><span id="demo-scan-progres"></span></div>

    <p class="demo-note">
      <i data-lucide="shield-check" aria-hidden="true"></i>
      ${MENTION_SIMULATION}
    </p>`;
}

function ecranPointageDemo() {
  const s = SCENARIOS_DEMO[demo.scenario];
  const fini = demo.etape >= 4 || demo.refuse;
  const lignes = [
    ligneEtapeDemo(1, demo.etape === 1, demo.etape > 1 && !demo.refuse, demo.refuse),
    demo.refuse ? '' : ligneEtapeDemo(2, demo.etape === 2, demo.etape > 2, false),
    demo.refuse ? '' : ligneEtapeDemo(3, demo.etape === 3, demo.etape > 3, false),
  ].join('');

  let resultat = '';
  if (demo.refuse) {
    resultat = `
      <div class="demo-resultat is-ko" role="status">
        <i data-lucide="shield-x" aria-hidden="true"></i>
        <p><strong>Pointage refusé</strong>Vous devez être dans la zone autorisée par votre entreprise pour pointer.</p>
      </div>`;
  } else if (demo.etape >= 4) {
    resultat = `
      <div class="demo-fiche" role="status">
        <p class="demo-fiche__titre">${s.retard ? 'Pointage enregistré ✓' : 'Pointage accepté ✓'}</p>
        <dl class="demo-fiche__liste">
          <div><dt>Employé</dt><dd>${echapDemo(EMPLOYE_DEMO)}</dd></div>
          <div><dt>Heure</dt><dd>${echapDemo(s.heure)}</dd></div>
          <div><dt>Statut</dt><dd>${s.retard ? `Retard — ${s.retard} min` : "À l'heure"}</dd></div>
          <div><dt>Méthode</dt><dd>Contrôle facial</dd></div>
          <div><dt>Position</dt><dd>Zone autorisée</dd></div>
        </dl>
      </div>`;
  }

  return `
    <div class="demo-tete">
      <h2 id="demo-titre" class="demo-titre" tabindex="-1">${fini ? 'Pointage terminé' : 'Pointage en cours'}</h2>
      <p class="demo-sous-titre">${echapDemo(s.libelle)} — ${echapDemo(EMPLOYE_DEMO)}</p>
    </div>
    <div class="demo-telephone">
      <ol class="demo-etapes">
        <li class="demo-etape is-ok">
          <span class="demo-etape__puce"><i data-lucide="check" aria-hidden="true"></i></span>
          <span class="demo-etape__texte"><strong>Contrôle facial simulé ✓</strong></span>
        </li>
        ${lignes}
      </ol>
      ${resultat}
    </div>
    ${fini ? `
      <button type="button" class="auth-bouton auth-bouton--principal" data-demo-action="cockpit">
        <span>Voir ce que reçoit le responsable RH</span>
        <i data-lucide="arrow-right" class="w-4 h-4" aria-hidden="true"></i>
      </button>` : ''}`;
}

function ecranCockpitDemo() {
  const s = SCENARIOS_DEMO[demo.scenario];
  const c = s.cockpit;
  const statutEmploye = !s.dansLaZone
    ? '<span class="demo-statut is-ko">Refusé : hors zone</span>'
    : s.retard
      ? `<span class="demo-statut is-alerte">Retard ${s.retard} min</span>`
      : '<span class="demo-statut is-ok">À l\'heure</span>';
  const coche = (ok) => (ok
    ? '<i data-lucide="check" class="demo-coche is-ok" aria-label="vérifié"></i>'
    : '<i data-lucide="x" class="demo-coche is-ko" aria-label="refusé"></i>');

  return `
    <div class="demo-tete">
      <h2 id="demo-titre" class="demo-titre" tabindex="-1">Maintenant, voyez ce que reçoit le responsable RH.</h2>
      <p class="demo-sous-titre">Le cockpit se met à jour à chaque pointage.</p>
    </div>

    <div class="demo-cockpit" aria-label="Cockpit RH (exemple)">
      <p class="demo-cockpit__exemple">Exemple fictif</p>
      <div class="demo-kpis">
        <div class="demo-kpi"><strong>${EFFECTIF_DEMO}</strong><span>employés</span></div>
        <div class="demo-kpi is-ok"><strong>${c.presents}</strong><span>présents</span></div>
        <div class="demo-kpi is-alerte"><strong>${c.retards}</strong><span>retardataires</span></div>
        <div class="demo-kpi is-ko"><strong>${c.absents}</strong><span>absents</span></div>
      </div>
      <div class="demo-tableau" role="table" aria-label="Pointages de ce matin">
        <div class="demo-ligne is-entete" role="row">
          <span role="columnheader">Collaborateur</span>
          <span role="columnheader">Heure</span>
          <span role="columnheader" title="Contrôle facial">Visage</span>
          <span role="columnheader" title="Zone">Zone</span>
          <span role="columnheader">Statut</span>
        </div>
        <div class="demo-ligne is-nouvelle" role="row">
          <span role="cell"><strong>${echapDemo(EMPLOYE_DEMO)}</strong></span>
          <span role="cell">${s.dansLaZone ? echapDemo(s.heure) : `Tentative ${echapDemo(s.heure)}`}</span>
          <span role="cell">${coche(true)}</span>
          <span role="cell">${coche(s.dansLaZone)}</span>
          <span role="cell">${statutEmploye}</span>
        </div>
      </div>
      ${!s.dansLaZone ? `
        <p class="demo-cockpit__alerte">
          <i data-lucide="bell-ring" aria-hidden="true"></i>
          La tentative refusée apparaît dans le cockpit, avec la distance mesurée.
        </p>` : ''}
    </div>

    <button type="button" class="auth-bouton auth-bouton--principal" data-demo-action="fin">
      <span>Continuer</span>
      <i data-lucide="arrow-right" class="w-4 h-4" aria-hidden="true"></i>
    </button>`;
}

function ecranFinDemo() {
  const prix = typeof prixMinimumTimora === 'function' ? prixMinimumTimora() : null;
  return `
    <div class="demo-tete">
      <span class="auth-succes" aria-hidden="true"><i data-lucide="check-check" class="w-6 h-6"></i></span>
      <h2 id="demo-titre" class="demo-titre" tabindex="-1">Voilà comment Timora sécurise un pointage en quelques secondes.</h2>
      <p class="demo-sous-titre">Faites maintenant la même chose avec votre équipe.</p>
    </div>

    <div class="auth-pile">
      <button type="button" class="auth-bouton auth-bouton--principal" data-demo-action="activer">
        <span>Créer mon entreprise</span>
        <i data-lucide="arrow-right" class="w-4 h-4" aria-hidden="true"></i>
      </button>
      ${prix ? `<p class="demo-prix">À partir de ${echapDemo(formaterFcfa(prix))} / mois</p>` : ''}
    </div>

    <ul class="demo-reassurance">
      <li><i data-lucide="check" aria-hidden="true"></i>Fonctionne sur smartphone</li>
      <li><i data-lucide="check" aria-hidden="true"></i>Aucun terminal physique</li>
      <li><i data-lucide="check" aria-hidden="true"></i>Mise en service rapide</li>
      <li><i data-lucide="check" aria-hidden="true"></i>Paiement sécurisé</li>
    </ul>

    <p class="auth-lien-secondaire">
      <button type="button" data-demo-action="recommencer">Rejouer la démonstration</button>
    </p>`;
}

function rendreDemo() {
  const zone = document.getElementById('demo-ecran');
  if (!zone) return;
  const ecrans = {
    intro: ecranIntroDemo,
    scan: ecranScanDemo,
    pointage: ecranPointageDemo,
    cockpit: ecranCockpitDemo,
    fin: ecranFinDemo,
  };
  const changementEcran = zone.dataset.ecran !== demo.ecran;
  zone.dataset.ecran = demo.ecran;
  zone.innerHTML = ecrans[demo.ecran]();
  if (window.lucide) window.lucide.createIcons();
  if (demo.ecran === 'scan') majScanDemo();

  // Le focus suit le changement d'ecran (lecteurs d'ecran, clavier), pas
  // chaque mise a jour d'etape.
  if (changementEcran) {
    const titre = document.getElementById('demo-titre');
    if (titre) titre.focus({ preventScroll: true });
  }
}

// -----------------------------------------------------------------------------
//  EVENEMENTS
// -----------------------------------------------------------------------------

function initialiserDemo() {
  const modale = document.getElementById('modal-punch');
  if (!modale) return;

  modale.addEventListener('click', (e) => {
    if (e.target === modale) {
      closePunchModal();
      return;
    }
    const cible = e.target.closest('[data-demo-action]');
    if (!cible) return;
    const action = cible.dataset.demoAction;
    if (action === 'fermer') closePunchModal();
    else if (action === 'pointer') lancerScanDemo();
    else if (action === 'cockpit') allerAuCockpitDemo();
    else if (action === 'fin') terminerDemo();
    else if (action === 'recommencer') recommencerDemo();
    else if (action === 'activer') {
      suivreDemo('demo_activation_clicked', { scenario: demo.scenario });
      closePunchModal();
      if (typeof activerMonEntreprise === 'function') activerMonEntreprise('demo');
    }
  });

  modale.addEventListener('change', (e) => {
    const radio = e.target.closest('[data-demo-scenario]');
    if (radio) choisirScenarioDemo(radio.value);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modale.hidden) closePunchModal();
  });

  // Onglet masque : on arrete les minuteurs plutot que de laisser la
  // demonstration se derouler dans le vide.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) annulerMinuteursDemo();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialiserDemo);
} else {
  initialiserDemo();
}
