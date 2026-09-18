/* =============================================================================
 *  TIMORA — DEMONSTRATION DE LA PAGE D'ACCUEIL
 * =============================================================================
 *
 *  Montre en moins d'une minute ce que fait Timora : un collaborateur pointe
 *  depuis son telephone, puis le responsable RH voit le resultat.
 *
 *  CE QUE CETTE DEMONSTRATION NE FAIT PAS, VOLONTAIREMENT
 *  -----------------------------------------------------
 *    - aucune camera, aucune position GPS, aucune biometrie ;
 *    - aucun compte, aucun appel au serveur, rien d'enregistre ;
 *    - aucun modele d'IA charge : elle reste instantanee sur un petit telephone.
 *
 *  Les noms et les chiffres du cockpit sont un EXEMPLE, affiche comme tel.
 *
 *  Point d'entree : openPunchModal() (nom conserve : les boutons de la page
 *  d'accueil l'appellent deja).
 * ========================================================================== */

const SCENARIOS_DEMO = {
  normal: {
    libelle: 'Pointage normal',
    icone: 'check-circle-2',
    heure: '08:03',
    dansLaZone: true,
    retard: 0,
    cockpit: { presents: 42, retards: 3, absents: 2 },
  },
  hors_zone: {
    libelle: 'Hors zone',
    icone: 'map-pin-off',
    heure: '08:05',
    dansLaZone: false,
    retard: 0,
    cockpit: { presents: 41, retards: 3, absents: 3 },
  },
  retard: {
    libelle: 'En retard',
    icone: 'alarm-clock',
    heure: '08:27',
    dansLaZone: true,
    retard: 27,
    cockpit: { presents: 42, retards: 4, absents: 2 },
  },
};

const EFFECTIF_DEMO = 48;

const demo = {
  ecran: 'intro',       // intro -> pointage -> cockpit -> fin
  scenario: 'normal',
  etape: 0,             // 0 a 3 pendant le pointage
  refuse: false,
  minuteurs: [],
  dejaDemarree: false,
  focusAvant: null,
};

function suivreDemo(nom, donnees = {}) {
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
  demo.minuteurs.push(setTimeout(fn, mouvementReduit() ? Math.min(ms, 250) : ms));
}

// -----------------------------------------------------------------------------
//  OUVERTURE / FERMETURE
// -----------------------------------------------------------------------------

function openPunchModal() {
  const modale = document.getElementById('modal-punch');
  if (!modale) return;
  demo.focusAvant = document.activeElement;
  demo.ecran = 'intro';
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

function lancerPointageDemo() {
  const s = SCENARIOS_DEMO[demo.scenario];
  if (!demo.dejaDemarree) {
    demo.dejaDemarree = true;
    suivreDemo('homepage_demo_started', { scenario: demo.scenario });
  }
  annulerMinuteursDemo();
  demo.ecran = 'pointage';
  demo.etape = 1;
  demo.refuse = false;
  rendreDemo();

  // Etape 1 : visage. Etape 2 : position. Etape 3 : enregistrement.
  plusTardDemo(() => { demo.etape = 2; rendreDemo(); }, 1100);
  plusTardDemo(() => {
    if (!s.dansLaZone) {
      demo.refuse = true;
      demo.etape = 3;
      rendreDemo();
      return;
    }
    demo.etape = 3;
    rendreDemo();
  }, 2200);
  if (s.dansLaZone) plusTardDemo(() => { demo.etape = 4; rendreDemo(); }, 3200);
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
  annulerMinuteursDemo();
  demo.ecran = 'intro';
  demo.etape = 0;
  demo.refuse = false;
  rendreDemo();
}

// -----------------------------------------------------------------------------
//  RENDU
// -----------------------------------------------------------------------------

const echapDemo = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));

function ligneEtapeDemo(numero, enCours, fait, ko) {
  const s = SCENARIOS_DEMO[demo.scenario];
  const etapes = {
    1: ['Analyse du visage…', 'Identité vérifiée', null],
    2: ['Vérification de la position…', 'Zone autorisée', 'Hors de la zone autorisée'],
    3: ['Enregistrement du pointage…', 'Présence enregistrée', null],
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
  const detail = numero === 3 && etat === 'ok'
    ? `<span class="demo-etape__detail">Arrivée — ${s.heure}${s.retard ? ` · Retard : ${s.retard} minutes` : ''}</span>`
    : '';
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
      <span><i data-lucide="${s.icone}" aria-hidden="true"></i>${s.libelle}</span>
    </label>`).join('');

  return `
    <div class="demo-tete">
      <h2 id="demo-titre" class="demo-titre" tabindex="-1">Essayez Timora maintenant</h2>
      <p class="demo-sous-titre">Vous êtes Kevin, collaborateur. Pointez votre arrivée comme depuis votre téléphone.</p>
    </div>

    <fieldset class="demo-scenarios">
      <legend>Choisissez une situation</legend>
      <div class="demo-scenarios__liste">${puces}</div>
    </fieldset>

    <div class="demo-telephone">
      <div class="demo-telephone__entete">
        <span class="demo-avatar" aria-hidden="true">KK</span>
        <span><strong>Kevin Kouassi</strong><small>Siège — Abidjan</small></span>
      </div>
      <button type="button" class="demo-bouton-pointer" data-demo-action="pointer">
        <i data-lucide="fingerprint" aria-hidden="true"></i>
        Pointer maintenant
      </button>
    </div>

    <p class="demo-note">
      <i data-lucide="info" aria-hidden="true"></i>
      Démonstration : aucune caméra, aucune position réelle, aucun compte. Rien n'est enregistré.
    </p>`;
}

function ecranPointageDemo() {
  const s = SCENARIOS_DEMO[demo.scenario];
  const fini = demo.etape >= 4 || demo.refuse;
  const lignes = [
    ligneEtapeDemo(1, demo.etape === 1, demo.etape > 1, false),
    ligneEtapeDemo(2, demo.etape === 2, demo.etape > 2 && !demo.refuse, demo.refuse),
    demo.refuse ? '' : ligneEtapeDemo(3, demo.etape === 3, demo.etape > 3, false),
  ].join('');

  let resultat = '';
  if (demo.refuse) {
    resultat = `
      <div class="demo-resultat is-ko" role="status">
        <i data-lucide="shield-x" aria-hidden="true"></i>
        <p><strong>Pointage non autorisé</strong>Vous êtes hors de la zone définie.</p>
      </div>`;
  } else if (demo.etape >= 4 && s.retard) {
    resultat = `
      <div class="demo-resultat is-alerte" role="status">
        <i data-lucide="alarm-clock" aria-hidden="true"></i>
        <p><strong>Retard : ${s.retard} minutes</strong>Visible immédiatement dans le cockpit RH.</p>
      </div>`;
  }

  return `
    <div class="demo-tete">
      <h2 id="demo-titre" class="demo-titre" tabindex="-1">${fini ? 'Pointage terminé' : 'Pointage en cours'}</h2>
      <p class="demo-sous-titre">${echapDemo(s.libelle)} — Kevin Kouassi</p>
    </div>
    <div class="demo-telephone">
      <ol class="demo-etapes">${lignes}</ol>
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
  const statutKevin = !s.dansLaZone
    ? '<span class="demo-statut is-ko">Refusé : hors zone</span>'
    : s.retard
      ? `<span class="demo-statut is-alerte">Retard ${s.retard} min</span>`
      : '<span class="demo-statut is-ok">Présent</span>';
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
          <span role="columnheader" title="Visage">Visage</span>
          <span role="columnheader" title="Zone">Zone</span>
          <span role="columnheader">Statut</span>
        </div>
        <div class="demo-ligne is-nouvelle" role="row">
          <span role="cell"><strong>Kevin Kouassi</strong></span>
          <span role="cell">${s.dansLaZone ? s.heure : '—'}</span>
          <span role="cell">${coche(true)}</span>
          <span role="cell">${coche(s.dansLaZone)}</span>
          <span role="cell">${statutKevin}</span>
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
      <h2 id="demo-titre" class="demo-titre" tabindex="-1">Vous venez de voir Timora fonctionner.</h2>
      <p class="demo-sous-titre">Faites maintenant la même chose avec votre équipe : activez Timora pour votre entreprise.</p>
    </div>

    <div class="auth-pile">
      <button type="button" class="auth-bouton auth-bouton--principal" data-demo-action="activer">
        <span>Activer mon entreprise</span>
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
      <button type="button" data-demo-action="recommencer">Essayer une autre situation</button>
    </p>`;
}

function rendreDemo() {
  const zone = document.getElementById('demo-ecran');
  if (!zone) return;
  const ecrans = {
    intro: ecranIntroDemo,
    pointage: ecranPointageDemo,
    cockpit: ecranCockpitDemo,
    fin: ecranFinDemo,
  };
  const changementEcran = zone.dataset.ecran !== demo.ecran;
  zone.dataset.ecran = demo.ecran;
  zone.innerHTML = ecrans[demo.ecran]();
  if (window.lucide) window.lucide.createIcons();

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
    else if (action === 'pointer') lancerPointageDemo();
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialiserDemo);
} else {
  initialiserDemo();
}
