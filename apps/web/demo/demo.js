/* =============================================================================
 *  TIMORA — DEMONSTRATION DE LA PAGE D'ACCUEIL
 * =============================================================================
 *
 *  Montre en moins d'une minute ce que fait Timora : un collaborateur pointe
 *  depuis son telephone, puis le responsable RH voit le resultat.
 *
 *  CE QUE CETTE DEMONSTRATION FAIT
 *  -------------------------------
 *    - elle ouvre la VRAIE camera du visiteur, avec son accord, pour qu'il se
 *      voie a l'ecran : c'est ce qui rend la promesse tangible ;
 *    - elle detecte LOCALEMENT qu'un visage est present dans le cadre.
 *
 *  CE QU'ELLE NE FAIT PAS, VOLONTAIREMENT
 *  --------------------------------------
 *    - aucune image n'est capturee, enregistree, televersee ou conservee ;
 *    - aucune empreinte biometrique n'est calculee : seul le DETECTEUR de
 *      visage est charge (0,2 Mo), jamais le modele de reconnaissance (6,3 Mo)
 *      qui, lui, produit un descripteur identifiant. La demo sait donc qu'« un
 *      visage est la », jamais « c'est telle personne » ;
 *    - aucune position reelle : navigator.geolocation n'est jamais appele ;
 *    - aucun compte, aucun appel au serveur, aucune ecriture en base.
 *
 *  Tout l'etat vit dans l'objet `demo` ci-dessous, en memoire. Fermer la
 *  modale ou recharger la page efface tout.
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

// Detecteur de visage : la meme bibliotheque que le produit, mais SEUL le
// modele de detection est charge. Le modele de reconnaissance (qui calcule
// une empreinte biometrique) n'est deliberement jamais telecharge ici.
const DEMO_FACE_LIB = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.min.js';
const DEMO_FACE_MODEL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';

const demo = {
  ecran: 'intro',       // intro -> camera -> pointage -> cockpit -> fin
  scenario: 'a_lheure',
  etape: 0,             // 0 a 3 pendant le pointage (position, horaire, enregistrement)
  refuse: false,
  minuteurs: [],
  dejaDemarree: false,
  focusAvant: null,
  // Etat de l'etape faciale
  face: {
    phase: 'attente',   // attente | ouverture | recherche | detecte | analyse | valide | refus | simulation
    message: '',
    stream: null,
    boucle: null,
    detecteurPret: false,
    chargement: false,
    boite: null,        // position du visage pour la surcouche, jamais transmise
    vuDepuis: 0,
  },
};

function suivreDemo(nom, donnees = {}) {
  // Suivi marketing uniquement : un nom d'etape et le scenario choisi.
  // Jamais d'image, de position, ni de contenu de la demonstration.
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
//  CAMERA — ouverture, detection locale, arret
// -----------------------------------------------------------------------------

/**
 * Coupe la camera et la boucle de detection. Appelee a la fermeture, a la fin
 * du parcours, sur abandon, au changement d'onglet et au dechargement de la
 * page : le voyant de la camera doit s'eteindre immediatement.
 */
function arreterCameraDemo() {
  if (demo.face.boucle) {
    clearTimeout(demo.face.boucle);
    demo.face.boucle = null;
  }
  if (demo.face.stream) {
    demo.face.stream.getTracks().forEach((piste) => piste.stop());
    demo.face.stream = null;
  }
  const video = document.getElementById('demo-video');
  if (video) {
    try { video.pause(); } catch { /* ignore */ }
    video.srcObject = null;
  }
  demo.face.boite = null;
}

/** Charge la bibliotheque puis le SEUL detecteur de visage. */
async function chargerDetecteurDemo() {
  if (demo.face.detecteurPret) return true;
  if (demo.face.chargement) return false;
  demo.face.chargement = true;
  try {
    if (typeof faceapi === 'undefined') {
      // chargerScriptUnique vient de app.js ; repli autonome si absent.
      if (typeof chargerScriptUnique === 'function') {
        await chargerScriptUnique(DEMO_FACE_LIB);
      } else {
        await new Promise((ok, ko) => {
          const s = document.createElement('script');
          s.src = DEMO_FACE_LIB;
          s.crossOrigin = 'anonymous';
          s.onload = ok;
          s.onerror = () => ko(new Error('chargement'));
          document.head.appendChild(s);
        });
      }
    }
    // Detection seule. Le modele de reconnaissance n'est PAS charge.
    if (!faceapi.nets.tinyFaceDetector.isLoaded) {
      await faceapi.nets.tinyFaceDetector.loadFromUri(DEMO_FACE_MODEL);
    }
    demo.face.detecteurPret = true;
    return true;
  } catch {
    // Reseau lent ou CDN bloque : la demo continue sans detection automatique.
    demo.face.detecteurPret = false;
    return false;
  } finally {
    demo.face.chargement = false;
  }
}

/**
 * Boucle de detection : toutes les ~250 ms, on demande au detecteur s'il voit
 * un visage. Rien n'est capture ni conserve : la lecture se fait directement
 * sur l'element <video>, et seule la position du cadre sert a l'affichage.
 */
function boucleDetectionDemo() {
  const video = document.getElementById('demo-video');
  if (!video || !demo.face.stream || demo.ecran !== 'camera') return;

  const suivant = (ms) => { demo.face.boucle = setTimeout(boucleDetectionDemo, ms); };

  if (!demo.face.detecteurPret || video.readyState < 2) {
    suivant(300);
    return;
  }

  faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 }))
    .then((resultat) => {
      if (demo.ecran !== 'camera' || !demo.face.stream) return;
      if (resultat && resultat.box) {
        const b = resultat.box;
        demo.face.boite = {
          gauche: (b.x / video.videoWidth) * 100,
          haut: (b.y / video.videoHeight) * 100,
          largeur: (b.width / video.videoWidth) * 100,
          hauteur: (b.height / video.videoHeight) * 100,
        };
        if (demo.face.phase === 'recherche' || demo.face.phase === 'aide') {
          demo.face.vuDepuis = Date.now();
          passerPhaseFaciale('detecte');
        }
      } else {
        demo.face.boite = null;
        if (demo.face.phase === 'detecte' && Date.now() - demo.face.vuDepuis > 1200) {
          passerPhaseFaciale('recherche');
        }
      }
      majSurcoucheDemo();
      suivant(250);
    })
    .catch(() => suivant(500));
}

/** Enchaine les phases de l'etape faciale et declenche la suite. */
function passerPhaseFaciale(phase) {
  const avant = demo.face.phase;
  demo.face.phase = phase;

  // « refus » et « aide » changent la STRUCTURE de l'ecran (bloc de repli,
  // bouton de secours) : il faut le reconstruire. Les autres phases ne font
  // que changer un texte et une barre — on evite alors de tout redessiner,
  // ce qui couperait l'image de la camera a chaque etape.
  const structurelles = ['refus', 'aide', 'simulation'];
  if (structurelles.includes(phase) || structurelles.includes(avant)) {
    rendreDemo();
  } else {
    majSurcoucheDemo();
  }

  if (phase === 'detecte') {
    plusTardDemo(() => {
      if (demo.ecran === 'camera' && demo.face.phase === 'detecte') passerPhaseFaciale('analyse');
    }, 900);
  } else if (phase === 'analyse') {
    plusTardDemo(() => {
      if (demo.ecran === 'camera' && demo.face.phase === 'analyse') passerPhaseFaciale('valide');
    }, 1400);
  } else if (phase === 'valide') {
    suivreDemo('demo_face_step_validated', { scenario: demo.scenario, mode: demo.face.stream ? 'camera' : 'simulation' });
    // La camera n'a plus rien a faire : on la coupe avant meme la suite.
    plusTardDemo(() => {
      arreterCameraDemo();
      lancerPointageDemo();
    }, 1100);
  }
}

/** Demande la camera. Un refus n'interrompt pas la demonstration. */
async function ouvrirCameraDemo() {
  demo.ecran = 'camera';
  demo.face.phase = 'ouverture';
  demo.face.boite = null;
  rendreDemo();

  if (!demo.dejaDemarree) {
    demo.dejaDemarree = true;
    suivreDemo('homepage_demo_started', { scenario: demo.scenario });
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    demo.face.message = "Votre navigateur ne permet pas d'accéder à la caméra.";
    passerPhaseFaciale('refus');
    return;
  }

  // Le detecteur se telecharge pendant que le visiteur accorde l'autorisation.
  const detecteur = chargerDetecteurDemo();

  try {
    demo.face.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 1280 } },
      audio: false,
    });
  } catch (e) {
    demo.face.message = e && e.name === 'NotFoundError'
      ? "Aucune caméra détectée sur cet appareil."
      : "Accès caméra non autorisé";
    suivreDemo('demo_camera_refused', { raison: (e && e.name) || 'inconnue' });
    passerPhaseFaciale('refus');
    return;
  }

  // La modale a pu etre fermee pendant que l'autorisation etait demandee.
  if (demo.ecran !== 'camera') {
    arreterCameraDemo();
    return;
  }

  passerPhaseFaciale('recherche');
  const video = document.getElementById('demo-video');
  if (video) {
    video.srcObject = demo.face.stream;
    try { await video.play(); } catch { /* lecture differee par le navigateur */ }
  }

  await detecteur;
  if (!demo.face.detecteurPret) {
    // Sans detecteur, on deroule quand meme : le visiteur se voit, la
    // progression est simulee. Jamais de fausse affirmation d'identite.
    plusTardDemo(() => {
      if (demo.ecran === 'camera' && demo.face.phase === 'recherche') passerPhaseFaciale('detecte');
    }, 1600);
    return;
  }
  boucleDetectionDemo();

  // Filet anti-impasse : contre-jour, visage hors cadre, camera masquee… La
  // demonstration ne doit jamais rester bloquee sur « Recherche du visage ».
  plusTardDemo(() => {
    if (demo.ecran === 'camera' && demo.face.phase === 'recherche') passerPhaseFaciale('aide');
  }, 9000);
}

/** Repli sans camera : avatar fictif, meme deroule. */
function continuerEnSimulationDemo() {
  arreterCameraDemo();
  demo.face.phase = 'simulation';
  rendreDemo();
  plusTardDemo(() => {
    if (demo.ecran === 'camera') passerPhaseFaciale('analyse');
  }, 1200);
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
  demo.face.phase = 'attente';
  demo.face.message = '';
  modale.hidden = false;
  document.documentElement.classList.add('demo-ouverte');
  rendreDemo();
}

function closePunchModal() {
  const modale = document.getElementById('modal-punch');
  annulerMinuteursDemo();
  arreterCameraDemo();            // la camera s'eteint avant tout le reste
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
  annulerMinuteursDemo();
  demo.ecran = 'pointage';
  demo.etape = 1;
  demo.refuse = false;
  rendreDemo();

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
  }, 1600);
  if (s.dansLaZone) {
    plusTardDemo(() => { demo.etape = 3; rendreDemo(); }, 2600);
    plusTardDemo(() => { demo.etape = 4; rendreDemo(); }, 3500);
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
  arreterCameraDemo();
  demo.ecran = 'intro';
  demo.etape = 0;
  demo.refuse = false;
  demo.face.phase = 'attente';
  demo.face.message = '';
  demo.face.boite = null;
  rendreDemo();
}

// -----------------------------------------------------------------------------
//  RENDU
// -----------------------------------------------------------------------------

const echapDemo = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));

const TEXTES_FACIAUX = {
  ouverture: 'Autorisez la caméra pour commencer…',
  recherche: 'Recherche du visage…',
  detecte: 'Visage détecté ✓',
  analyse: 'Analyse en cours…',
  valide: 'Étape faciale validée ✓',
  simulation: 'Simulation — aucun visage réel analysé',
  aide: 'Aucun visage détecté pour l\'instant',
};

const ETAT_PHASE = {
  ouverture: 'attente', recherche: 'attente', detecte: 'ok',
  analyse: 'attente', valide: 'ok', simulation: 'attente', aide: 'attente',
};

/** Met a jour la surcouche sans reconstruire tout l'ecran (fluidite mobile). */
function majSurcoucheDemo() {
  const zone = document.getElementById('demo-cadre');
  const statut = document.getElementById('demo-face-statut');
  if (statut) {
    statut.textContent = TEXTES_FACIAUX[demo.face.phase] || '';
    statut.dataset.etat = ETAT_PHASE[demo.face.phase] || 'attente';
  }
  if (zone) {
    zone.dataset.phase = demo.face.phase;
    const b = demo.face.boite;
    if (b) {
      // La camera frontale est en miroir : on inverse l'axe horizontal pour
      // que le cadre suive le visage tel que le visiteur se voit.
      zone.style.setProperty('--boite-gauche', `${(100 - b.gauche - b.largeur).toFixed(2)}%`);
      zone.style.setProperty('--boite-haut', `${b.haut.toFixed(2)}%`);
      zone.style.setProperty('--boite-largeur', `${b.largeur.toFixed(2)}%`);
      zone.style.setProperty('--boite-hauteur', `${b.hauteur.toFixed(2)}%`);
      zone.classList.add('a-visage');
    } else {
      zone.classList.remove('a-visage');
    }
  }
  const barre = document.getElementById('demo-face-progres');
  if (barre) {
    const avancement = { ouverture: 5, recherche: 20, aide: 20, detecte: 55, analyse: 80, valide: 100, simulation: 55 };
    barre.style.width = `${avancement[demo.face.phase] || 0}%`;
  }
}

function ligneEtapeDemo(numero, enCours, fait, ko) {
  const s = SCENARIOS_DEMO[demo.scenario];
  const etapes = {
    1: ['Vérification de votre position…', 'Vous êtes dans la zone autorisée', 'Hors de la zone autorisée'],
    2: ["Contrôle de l'horaire…", s.retard ? `Retard — ${s.retard} min` : "Arrivée à l'heure", null],
    3: ['Enregistrement du pointage…', 'Pointage enregistré', null],
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
      <p class="demo-sous-titre">Pointez comme le ferait un collaborateur : votre visage, puis votre position.</p>
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
      <button type="button" class="demo-bouton-pointer" data-demo-action="camera">
        <i data-lucide="scan-face" aria-hidden="true"></i>
        Démarrer le pointage facial
      </button>
    </div>

    <p class="demo-note">
      <i data-lucide="shield-check" aria-hidden="true"></i>
      Démo interactive — votre caméra est utilisée uniquement sur cet appareil.
      Aucune image, donnée biométrique ou donnée de pointage n'est enregistrée.
    </p>`;
}

function ecranCameraDemo() {
  const refus = demo.face.phase === 'refus';
  const simulation = demo.face.phase === 'simulation';

  const corps = refus
    ? `
      <div class="demo-camera-refus" role="status">
        <i data-lucide="camera-off" aria-hidden="true"></i>
        <p><strong>${echapDemo(demo.face.message || 'Accès caméra non autorisé')}</strong>
        La démonstration fonctionne aussi sans caméra.</p>
        <button type="button" class="auth-bouton auth-bouton--principal" data-demo-action="simulation">
          <span>Continuer avec une simulation</span>
          <i data-lucide="arrow-right" class="w-4 h-4" aria-hidden="true"></i>
        </button>
      </div>`
    : `
      <div id="demo-cadre" class="demo-cadre" data-phase="${demo.face.phase}">
        ${simulation
          ? `<div class="demo-avatar-simule" aria-hidden="true"><i data-lucide="user-round"></i></div>`
          : `<video id="demo-video" class="demo-video" playsinline muted autoplay
                   aria-label="Aperçu de votre caméra, affiché uniquement sur cet appareil"></video>`}
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
      </div>`;

  return `
    <div class="demo-tete">
      <h2 id="demo-titre" class="demo-titre" tabindex="-1">Contrôle facial</h2>
      <p class="demo-sous-titre">Placez votre visage dans le cadre.</p>
    </div>

    ${corps}

    ${refus ? '' : `
      <p id="demo-face-statut" class="demo-face-statut" data-etat="${ETAT_PHASE[demo.face.phase] || 'attente'}" role="status">
        ${echapDemo(TEXTES_FACIAUX[demo.face.phase] || '')}
      </p>
      <div class="demo-progres" aria-hidden="true"><span id="demo-face-progres"></span></div>`}

    ${demo.face.phase === 'aide' ? `
      <div class="demo-camera-aide">
        <p>Rapprochez-vous, vérifiez l'éclairage et regardez l'objectif — ou poursuivez la démonstration.</p>
        <button type="button" class="auth-bouton auth-bouton--principal" data-demo-action="poursuivre">
          <span>Poursuivre la démonstration</span>
          <i data-lucide="arrow-right" class="w-4 h-4" aria-hidden="true"></i>
        </button>
      </div>` : ''}

    <p class="demo-note">
      <i data-lucide="shield-check" aria-hidden="true"></i>
      Démo interactive — votre caméra est utilisée uniquement sur cet appareil.
      Aucune image, donnée biométrique ou donnée de pointage n'est enregistrée.
    </p>

    <p class="auth-lien-secondaire">
      <button type="button" data-demo-action="recommencer">Revenir au début</button>
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
        <p class="demo-fiche__titre">${s.retard ? 'Pointage enregistré' : 'Pointage accepté'}</p>
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
          <span class="demo-etape__texte"><strong>Étape faciale validée</strong></span>
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
    camera: ecranCameraDemo,
    pointage: ecranPointageDemo,
    cockpit: ecranCockpitDemo,
    fin: ecranFinDemo,
  };
  const changementEcran = zone.dataset.ecran !== demo.ecran;
  zone.dataset.ecran = demo.ecran;
  zone.innerHTML = ecrans[demo.ecran]();
  if (window.lucide) window.lucide.createIcons();

  // Le flux est rebranche apres chaque reconstruction de l'ecran camera.
  if (demo.ecran === 'camera' && demo.face.stream) {
    const video = document.getElementById('demo-video');
    if (video && !video.srcObject) {
      video.srcObject = demo.face.stream;
      video.play().catch(() => { /* lecture differee */ });
    }
  }
  if (demo.ecran === 'camera') majSurcoucheDemo();

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
    else if (action === 'camera') ouvrirCameraDemo();
    else if (action === 'simulation') continuerEnSimulationDemo();
    else if (action === 'poursuivre') passerPhaseFaciale('analyse');
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

  // Filets de securite : la camera ne doit jamais rester allumee si le
  // visiteur quitte l'onglet, revient en arriere ou ferme la page.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) arreterCameraDemo();
  });
  window.addEventListener('pagehide', arreterCameraDemo);
  window.addEventListener('beforeunload', arreterCameraDemo);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialiserDemo);
} else {
  initialiserDemo();
}
