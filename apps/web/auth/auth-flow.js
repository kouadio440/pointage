/* =============================================================================
 *  TIMORA — PARCOURS D'AUTHENTIFICATION
 * =============================================================================
 *
 *  UNE SEULE DECISION PAR ECRAN
 *  ----------------------------
 *    Bienvenue ─┬─ Je suis une entreprise ─┬─ Me connecter ────────┐
 *               │                          └─ Creer mon entreprise ┤
 *               │                                                  ├─ Google ou e-mail (+ code)
 *               └─ Je suis un employe ── Code entreprise ──────────┘
 *                                                                  │
 *                                              resolve_auth_context (serveur)
 *                                                                  │
 *          cockpit entreprise · espace employe · onboarding · attente RH · choix
 *
 *  LA DESTINATION N'EST JAMAIS DEVINEE ICI
 *  ---------------------------------------
 *  Apres toute authentification — code e-mail, Google, mot de passe, ou simple
 *  rechargement — `resoudreEtOrienter()` interroge `resolve_auth_context()` et
 *  suit la destination renvoyee. Le role vient des rattachements en base, pas
 *  d'une fiche `users`, pas d'une valeur par defaut. L'ancien code retombait
 *  sur EMPLOYEE en l'absence d'information : c'est ce qui envoyait un createur
 *  d'entreprise vers l'espace employe.
 *
 *  ETAT DU PARCOURS
 *  ----------------
 *  Une seule variable (`flux`), un seul etat courant, persistes en
 *  sessionStorage : un rechargement de l'ecran de code ou du formulaire
 *  d'entreprise reprend la ou il etait. sessionStorage plutot que localStorage :
 *  l'etat disparait a la fermeture de l'onglet, et n'y figurent ni code, ni
 *  jeton, ni mot de passe.
 * ========================================================================== */

const ETATS_AUTH = Object.freeze({
  SELECT_PROFILE: 'SELECT_PROFILE',
  COMPANY_AUTH: 'COMPANY_AUTH',
  AUTH_METHOD: 'AUTH_METHOD',
  EMPLOYEE_COMPANY_CODE: 'EMPLOYEE_COMPANY_CODE',
  EMPLOYEE_COMPANY_CONFIRM: 'EMPLOYEE_COMPANY_CONFIRM',
  EMAIL_ENTRY: 'EMAIL_ENTRY',
  PASSWORD_ENTRY: 'PASSWORD_ENTRY',
  OTP_PENDING: 'OTP_PENDING',
  OTP_VERIFYING: 'OTP_VERIFYING',
  AUTH_RESOLVING: 'AUTH_RESOLVING',
  COMPANY_ONBOARDING: 'COMPANY_ONBOARDING',
  NO_MEMBERSHIP: 'NO_MEMBERSHIP',
  AUTHENTICATED: 'AUTHENTICATED',
  ERROR: 'ERROR',
});

/** Intentions : ce que l'utilisateur a choisi. Seules les trois premieres existent cote serveur. */
const INTENTIONS_AUTH = Object.freeze({
  CONNEXION_ENTREPRISE: 'company_login',
  CREATION_ENTREPRISE: 'company_signup',
  ADHESION_EMPLOYE: 'employee_join',
  CONNEXION_EMPLOYE: 'employee_login',
});

const CLE_FLUX_AUTH = 'timora_auth_flux';
const CLE_RETOUR_AUTH = 'timora_retour_apres_auth';
const CLE_ENTREPRISE_PREFEREE = 'timora_entreprise_preferee';

/** Duree de validite d'un code (reglage Supabase `mailer_otp_exp` : 600 s). */
const OTP_VALIDITE_MS = 10 * 60 * 1000;
/** Un parcours interrompu (code en attente, formulaire d'entreprise) est repris pendant une heure. */
const FLUX_VALIDITE_MS = 60 * 60 * 1000;
/** Intervalle minimal impose par Supabase entre deux envois a la meme adresse. */
const OTP_DELAI_RENVOI_S = 60;
const OTP_LONGUEUR = 6;

const EFFECTIFS_ENTREPRISE = [
  { valeur: '1-10', libelle: '1 – 10' },
  { valeur: '11-30', libelle: '11 – 30' },
  { valeur: '31-100', libelle: '31 – 100' },
  { valeur: '100+', libelle: '100 et plus' },
];

const PAYS_ENTREPRISE = [
  "Côte d'Ivoire", 'Sénégal', 'Mali', 'Burkina Faso', 'Bénin', 'Togo', 'Guinée', 'Niger',
  'Cameroun', 'Gabon', 'Congo', 'RD Congo', 'Madagascar', 'Maroc', 'Tunisie', 'France', 'Autre pays',
];

let flux = fluxInitial();
let minuteurRenvoi = null;
let requeteEnCours = false;

function fluxInitial() {
  return {
    etat: ETATS_AUTH.SELECT_PROFILE,
    intention: null,
    email: '',
    otpEnvoyeA: 0,
    renvoiPossibleA: 0,
    entreprise: null,
    brouillon: {},
    erreur: null,
    pile: [],
    majA: Date.now(),
  };
}

// -----------------------------------------------------------------------------
//  ROLES — vocabulaire unique cote navigateur
// -----------------------------------------------------------------------------

/**
 * Role canonique, en majuscules : OWNER, ADMIN, MANAGER ou EMPLOYEE.
 *
 * Les anciens libelles (CEO, HR, COMPANY_ADMIN) restent compris : la base les
 * emploie encore jusqu'a la migration 027. Un role absent vaut `null` — jamais
 * EMPLOYEE par defaut.
 */
function roleCanonique(role) {
  const r = String(role || '').trim().toUpperCase();
  if (!r) return null;
  if (r === 'OWNER' || r === 'CEO') return 'OWNER';
  if (r === 'ADMIN' || r === 'HR' || r === 'COMPANY_ADMIN' || r === 'SUPER_ADMIN') return 'ADMIN';
  if (r === 'MANAGER') return 'MANAGER';
  return 'EMPLOYEE';
}

/** Role donnant acces au cockpit entreprise. */
function estRoleEntreprise(role) {
  const r = roleCanonique(role);
  return r === 'OWNER' || r === 'ADMIN' || r === 'MANAGER';
}

/** Role autorise a configurer l'entreprise (sites, horaires, reconnaissance faciale). */
function estRoleConfigurateur(role) {
  const r = roleCanonique(role);
  return r === 'OWNER' || r === 'ADMIN';
}

function libelleRole(role) {
  return {
    OWNER: 'Propriétaire',
    ADMIN: 'Administrateur RH',
    MANAGER: 'Manager',
    EMPLOYEE: 'Employé',
  }[roleCanonique(role)] || 'Membre';
}

// -----------------------------------------------------------------------------
//  PERSISTANCE DU PARCOURS
// -----------------------------------------------------------------------------

function sauverFlux() {
  flux.majA = Date.now();
  try {
    // La pile et l'etat suffisent a reprendre ; l'erreur affichee est transitoire.
    const { erreur, ...persistable } = flux;
    sessionStorage.setItem(CLE_FLUX_AUTH, JSON.stringify(persistable));
  } catch (err) {
    /* Stockage indisponible (navigation privee stricte) : le parcours continue en memoire. */
  }
}

function effacerFlux() {
  flux = fluxInitial();
  arreterMinuteurRenvoi();
  try { sessionStorage.removeItem(CLE_FLUX_AUTH); } catch (err) { /* sans consequence */ }
}

/** Relit un parcours interrompu (rechargement, retour de Google). Un parcours de plus d'une heure est abandonne. */
function relireFlux() {
  try {
    const brut = sessionStorage.getItem(CLE_FLUX_AUTH);
    if (!brut) return null;
    const lu = JSON.parse(brut);
    if (!lu || !lu.etat || Date.now() - (lu.majA || 0) > FLUX_VALIDITE_MS) {
      sessionStorage.removeItem(CLE_FLUX_AUTH);
      return null;
    }
    return { ...fluxInitial(), ...lu, erreur: null };
  } catch (err) {
    return null;
  }
}

// -----------------------------------------------------------------------------
//  MESURE ET JOURNAL
// -----------------------------------------------------------------------------

/** Evenement d'analyse : jamais d'adresse, de code, de jeton ni de mot de passe. */
function suivreAuth(nom, donnees = {}) {
  const charge = { event: nom, ...donnees };
  try {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(charge);
    window.dispatchEvent(new CustomEvent('timora:analytics', { detail: charge }));
  } catch (err) {
    /* La mesure ne doit jamais bloquer une connexion. */
  }
}

/** Parcours cote serveur (liste fermee) ; l'intention « connexion employe » n'en a pas. */
function fluxServeur(intention) {
  return ['company_login', 'company_signup', 'employee_join'].includes(intention) ? intention : null;
}

/**
 * Journal d'authentification cote serveur, sans attendre la reponse.
 *
 * Le code OTP n'est JAMAIS transmis. L'adresse est reduite par le serveur a
 * une empreinte et a son domaine.
 */
function journaliserAuth(evenement, { email = flux.email, codeErreur = null } = {}) {
  if (!supabaseClient) return;
  try {
    supabaseClient.rpc('log_auth_event', {
      p_event: evenement,
      p_email: email || null,
      p_error_code: codeErreur,
      p_flow: fluxServeur(flux.intention),
    }).then(() => {}, () => {});
  } catch (err) {
    /* Le journal ne doit jamais bloquer une connexion. */
  }
}

// -----------------------------------------------------------------------------
//  ERREURS : des messages simples, jamais le texte brut du serveur
// -----------------------------------------------------------------------------

const MESSAGES_ERREUR_AUTH = {
  CODE_INVALID: 'Ce code est incorrect.',
  CODE_EXPIRED: 'Ce code a expiré. Demandez-en un nouveau.',
  TOO_MANY_ATTEMPTS: 'Trop de tentatives. Réessayez dans quelques minutes.',
  SEND_RATE_LIMITED: 'Un code vient déjà d\'être envoyé à cette adresse. Patientez avant d\'en demander un autre.',
  EMAIL_SEND_FAILED: 'Impossible d\'envoyer l\'email pour le moment. Réessayez dans quelques minutes.',
  EMAIL_QUOTA_EXCEEDED: 'Trop d\'emails ont été envoyés récemment. Réessayez dans quelques minutes, ou continuez avec Google.',
  EMAIL_INVALID: 'Cette adresse email n\'est pas valide.',
  INVALID_CREDENTIALS: 'Adresse email ou mot de passe incorrect.',
  NETWORK_ERROR: 'Connexion internet indisponible. Vérifiez votre réseau puis réessayez.',
  COMPANY_CODE_INVALID: 'Aucune entreprise ne correspond à ce code.',
  COMPANY_SUSPENDED: 'L\'abonnement de cette entreprise est suspendu. Contactez votre responsable.',
  EMAIL_NOT_VERIFIED: 'Votre adresse email n\'est pas vérifiée. Connectez-vous avec un code reçu par email.',
  UNKNOWN_ERROR: 'Une erreur inattendue est survenue. Réessayez.',
};

/**
 * Classe une erreur Supabase (Auth ou base) dans une categorie connue.
 *
 * Supabase renvoie le meme code `otp_expired` pour un code faux et pour un code
 * perime : on les departage par l'age de la demande.
 */
function classerErreurAuth(err, contexte = {}) {
  if (!err) return 'UNKNOWN_ERROR';

  const code = String(err.code || err.error_code || '').toLowerCase();
  const statut = Number(err.status || 0);
  const message = String(err.message || '').toLowerCase();

  if ((typeof navigator !== 'undefined' && navigator.onLine === false)
      || err.name === 'AuthRetryableFetchError' || err instanceof TypeError
      || /failed to fetch|networkerror|load failed|network request failed/.test(message)) {
    return 'NETWORK_ERROR';
  }

  if (code === 'tm404') return 'COMPANY_CODE_INVALID';
  if (code === 'tm403') return 'COMPANY_SUSPENDED';
  if (code === 'tm401') return 'EMAIL_NOT_VERIFIED';

  // Supabase emploie le meme code pour deux refus tres differents :
  //   « ... only request this after 42 seconds » : un code est DEJA parti a
  //     cette adresse, il suffit de le saisir ;
  //   « email rate limit exceeded » : le quota d'envoi du projet est epuise,
  //     AUCUN email n'est parti. Afficher l'ecran de saisie serait mentir.
  if (code === 'over_email_send_rate_limit' || (contexte.envoi && statut === 429)) {
    return /after\s+\d+\s+second/.test(message) ? 'SEND_RATE_LIMITED' : 'EMAIL_QUOTA_EXCEEDED';
  }
  if (code === 'over_request_rate_limit' || statut === 429) return 'TOO_MANY_ATTEMPTS';

  if (code === 'otp_expired' || code === 'otp_disabled' || /token has expired|otp.*(invalid|expired)/.test(message)) {
    const age = contexte.otpEnvoyeA ? Date.now() - contexte.otpEnvoyeA : 0;
    return age > OTP_VALIDITE_MS ? 'CODE_EXPIRED' : 'CODE_INVALID';
  }

  if (code === 'invalid_credentials' || /invalid login credentials/.test(message)) return 'INVALID_CREDENTIALS';
  if (code === 'email_address_invalid' || code === 'validation_failed' || /invalid.*email|email.*invalid/.test(message)) {
    return 'EMAIL_INVALID';
  }

  if (contexte.envoi && (statut >= 500 || code === 'unexpected_failure' || code === 'email_provider_disabled'
      || /error sending|smtp|email/.test(message))) {
    return 'EMAIL_SEND_FAILED';
  }

  return 'UNKNOWN_ERROR';
}

/** Secondes d'attente annoncees par Supabase (« ... after 42 seconds »), sinon le delai par defaut. */
function secondesAvantRenvoi(err) {
  const m = /after\s+(\d+)\s+second/i.exec(String((err && err.message) || ''));
  return m ? Math.max(1, Number(m[1])) : OTP_DELAI_RENVOI_S;
}

function adresseEmailValide(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
}

// -----------------------------------------------------------------------------
//  OUVERTURE, FERMETURE, NAVIGATION
// -----------------------------------------------------------------------------

function elementAuth(id) {
  return document.getElementById(id);
}

/**
 * Ouvre le parcours.
 *
 * `etat` et `intention` fixent le point d'entree. Un code en attente de saisie
 * ou un formulaire d'entreprise inacheve est repris plutot qu'ecrase : ouvrir
 * « Se connecter » ne doit pas faire perdre un code qu'on s'appretait a taper.
 */
function ouvrirAuthentification({ etat = ETATS_AUTH.SELECT_PROFILE, intention = null, entreprise = null, reprendre = true, pile = [] } = {}) {
  const repris = reprendre ? relireFlux() : null;
  const reprendrePossible = repris && [ETATS_AUTH.OTP_PENDING, ETATS_AUTH.COMPANY_ONBOARDING].includes(repris.etat)
    && (etat === ETATS_AUTH.SELECT_PROFILE || repris.intention === intention);

  if (reprendrePossible) {
    flux = repris;
  } else {
    arreterMinuteurRenvoi();
    flux = fluxInitial();
    flux.etat = etat;
    flux.intention = intention;
    flux.entreprise = entreprise;
    // Etapes « virtuelles » en amont : entrer directement sur « Creer mon
    // entreprise » depuis la page des tarifs laisse revenir au choix du profil.
    flux.pile = pile.slice();
  }

  const modale = elementAuth('modal-auth');
  if (!modale) return;
  modale.hidden = false;
  document.documentElement.classList.add('auth-ouverte');
  sauverFlux();
  rendreAuthentification();
}

/**
 * Fermeture volontaire (bouton ×).
 *
 * Il n'existe AUCUNE fermeture par clic sur le fond ni par Echap : un geste
 * involontaire ne doit pas faire perdre un code en cours de saisie ou un
 * formulaire rempli. Le parcours reste memorise : rouvrir la fenetre y ramene.
 */
function fermerAuthentification({ oublier = false } = {}) {
  const modale = elementAuth('modal-auth');
  if (modale) modale.hidden = true;
  document.documentElement.classList.remove('auth-ouverte');
  arreterMinuteurRenvoi();
  if (oublier) effacerFlux();
}

function allerA(etat, modifications = {}) {
  if (flux.etat !== etat && ![ETATS_AUTH.OTP_VERIFYING, ETATS_AUTH.AUTH_RESOLVING, ETATS_AUTH.ERROR].includes(flux.etat)) {
    flux.pile.push(flux.etat);
  }
  Object.assign(flux, modifications, { etat, erreur: modifications.erreur || null });
  sauverFlux();
  rendreAuthentification();
}

function revenir() {
  if (requeteEnCours) return;
  const precedent = flux.pile.pop();
  flux.erreur = null;
  flux.etat = precedent || ETATS_AUTH.SELECT_PROFILE;
  if (flux.etat === ETATS_AUTH.SELECT_PROFILE) flux.intention = null;
  arreterMinuteurRenvoi();
  sauverFlux();
  rendreAuthentification();
}

function afficherErreur(code) {
  flux.erreur = code;
  rendreAuthentification();
}

// -----------------------------------------------------------------------------
//  RENDU
// -----------------------------------------------------------------------------

const ICONE_GOOGLE = `<svg class="bouton-google__logo" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

function blocErreur() {
  if (!flux.erreur) return '<p id="auth-erreur" class="auth-erreur" role="alert" hidden></p>';
  return `<p id="auth-erreur" class="auth-erreur" role="alert">
    <i data-lucide="alert-circle" class="w-4 h-4" aria-hidden="true"></i>
    <span>${escapeHtml(MESSAGES_ERREUR_AUTH[flux.erreur] || MESSAGES_ERREUR_AUTH.UNKNOWN_ERROR)}</span>
  </p>`;
}

function entete(titre, sousTitre = '') {
  return `<div class="auth-tete">
    <h2 id="auth-titre" class="auth-titre" tabindex="-1">${titre}</h2>
    ${sousTitre ? `<p class="auth-sous-titre">${sousTitre}</p>` : ''}
  </div>`;
}

function carteChoix(action, valeur, icone, titre, description) {
  return `<button type="button" class="auth-choix" data-auth-action="${action}" data-valeur="${valeur}">
    <span class="auth-choix__icone" aria-hidden="true"><i data-lucide="${icone}" class="w-5 h-5"></i></span>
    <span class="auth-choix__texte"><strong>${titre}</strong><span>${description}</span></span>
    <i data-lucide="chevron-right" class="w-4 h-4 auth-choix__fleche" aria-hidden="true"></i>
  </button>`;
}

function boutonsMethodes() {
  return `<div class="auth-pile">
    <button type="button" class="bouton-google" data-auth-action="google">
      ${ICONE_GOOGLE}<span>Continuer avec Google</span>
    </button>
    <div class="separateur-ou" role="separator"><span>ou</span></div>
    <button type="button" class="auth-bouton auth-bouton--secondaire" data-auth-action="methode-email">
      <i data-lucide="mail" class="w-4 h-4" aria-hidden="true"></i><span>Continuer avec mon email</span>
    </button>
  </div>`;
}

function titreSelonIntention() {
  switch (flux.intention) {
    case INTENTIONS_AUTH.CREATION_ENTREPRISE:
      return ['Créer mon entreprise', 'Vérifions d\'abord votre identité. Les informations de l\'entreprise viendront juste après.'];
    case INTENTIONS_AUTH.ADHESION_EMPLOYE:
      return [`Rejoindre ${escapeHtml((flux.entreprise && flux.entreprise.name) || 'mon entreprise')}`,
        'Identifiez-vous pour envoyer votre demande à votre service RH.'];
    case INTENTIONS_AUTH.CONNEXION_EMPLOYE:
      return ['Connexion employé', 'Retrouvez votre espace de pointage.'];
    default:
      return ['Connexion à Timora', 'Accédez à l\'espace de votre entreprise.'];
  }
}

const ECRANS_AUTH = {
  [ETATS_AUTH.SELECT_PROFILE]: () => `
    ${entete('Bienvenue sur Timora', 'Pour commencer, dites-nous qui vous êtes.')}
    <div class="auth-pile">
      ${carteChoix('profil', 'entreprise', 'building-2', 'Je suis une entreprise', 'Dirigeant, service RH ou manager')}
      ${carteChoix('profil', 'employe', 'user-check', 'Je suis un employé', 'Je pointe et je consulte mon espace')}
    </div>`,

  [ETATS_AUTH.COMPANY_AUTH]: () => `
    ${entete('Espace entreprise', 'Que souhaitez-vous faire ?')}
    <div class="auth-pile">
      ${carteChoix('intention', INTENTIONS_AUTH.CONNEXION_ENTREPRISE, 'log-in', 'Me connecter', 'Mon entreprise utilise déjà Timora')}
      ${carteChoix('intention', INTENTIONS_AUTH.CREATION_ENTREPRISE, 'sparkles', 'Créer mon entreprise', '7 jours gratuits, sans carte bancaire')}
    </div>`,

  [ETATS_AUTH.AUTH_METHOD]: () => {
    const [titre, sousTitre] = titreSelonIntention();
    return `${entete(titre, sousTitre)}${blocErreur()}${boutonsMethodes()}`;
  },

  [ETATS_AUTH.EMPLOYEE_COMPANY_CODE]: () => `
    ${entete('Rejoindre mon entreprise', 'Saisissez le code communiqué par votre service RH.')}
    <form class="auth-pile" data-auth-form="code-entreprise" novalidate>
      <div class="auth-champ">
        <label for="auth-code-entreprise">Code entreprise</label>
        <input id="auth-code-entreprise" name="code" type="text" inputmode="text" autocomplete="off"
               autocapitalize="characters" spellcheck="false" maxlength="32" required
               placeholder="TIM-XXXX-XXXX" value="${escapeHtml((flux.entreprise && flux.entreprise.code) || '')}"
               aria-describedby="auth-erreur" ${flux.erreur ? 'aria-invalid="true"' : ''} />
      </div>
      ${blocErreur()}
      <button type="submit" class="auth-bouton auth-bouton--principal" data-libelle-attente="Recherche…">
        <span>Continuer</span>
      </button>
    </form>
    <p class="auth-lien-secondaire">
      <button type="button" data-auth-action="connexion-employe">J'ai déjà un compte employé</button>
    </p>`,

  [ETATS_AUTH.EMPLOYEE_COMPANY_CONFIRM]: () => {
    const e = flux.entreprise || {};
    const connecte = !!(state && state.isAuthenticated && state.currentUser && state.currentUser.id);
    return `
      ${entete('Vous rejoignez')}
      <div class="auth-entreprise" role="group" aria-label="Entreprise trouvée">
        <span class="auth-entreprise__icone" aria-hidden="true"><i data-lucide="building-2" class="w-6 h-6"></i></span>
        <span class="auth-entreprise__texte">
          <strong>${escapeHtml(e.name || '')}</strong>
          ${e.city ? `<span>${escapeHtml(e.city)}</span>` : ''}
        </span>
      </div>
      ${blocErreur()}
      ${connecte
        ? `<button type="button" class="auth-bouton auth-bouton--principal" data-auth-action="rejoindre-connecte">
             <span>Envoyer ma demande</span></button>`
        : boutonsMethodes()}
      <p class="auth-lien-secondaire">
        <button type="button" data-auth-action="retour">Ce n'est pas mon entreprise</button>
      </p>`;
  },

  [ETATS_AUTH.EMAIL_ENTRY]: () => {
    const [titre] = titreSelonIntention();
    const connexion = [INTENTIONS_AUTH.CONNEXION_ENTREPRISE, INTENTIONS_AUTH.CONNEXION_EMPLOYE].includes(flux.intention);
    return `
      ${entete(titre, 'Nous vous envoyons un code de connexion à 6 chiffres.')}
      <form class="auth-pile" data-auth-form="email" novalidate>
        <div class="auth-champ">
          <label for="auth-email">Email professionnel</label>
          <input id="auth-email" name="email" type="email" inputmode="email" autocomplete="email"
                 autocapitalize="off" spellcheck="false" required placeholder="nom@entreprise.com"
                 value="${escapeHtml(flux.email || '')}" aria-describedby="auth-erreur"
                 ${flux.erreur ? 'aria-invalid="true"' : ''} />
        </div>
        ${blocErreur()}
        <button type="submit" class="auth-bouton auth-bouton--principal" data-libelle-attente="Envoi du code…">
          <span>Continuer</span>
        </button>
      </form>
      ${connexion ? `<p class="auth-lien-secondaire">
        <button type="button" data-auth-action="mot-de-passe">Utiliser mon mot de passe</button></p>` : ''}`;
  },

  [ETATS_AUTH.PASSWORD_ENTRY]: () => `
    ${entete('Connexion par mot de passe')}
    <form class="auth-pile" data-auth-form="mot-de-passe" novalidate>
      <div class="auth-champ">
        <label for="auth-email-mdp">Email professionnel</label>
        <input id="auth-email-mdp" name="email" type="email" autocomplete="username" required
               value="${escapeHtml(flux.email || '')}" placeholder="nom@entreprise.com" />
      </div>
      <div class="auth-champ">
        <label for="auth-mdp">Mot de passe</label>
        <input id="auth-mdp" name="motdepasse" type="password" autocomplete="current-password" required
               aria-describedby="auth-erreur" ${flux.erreur ? 'aria-invalid="true"' : ''} />
      </div>
      ${blocErreur()}
      <button type="submit" class="auth-bouton auth-bouton--principal" data-libelle-attente="Connexion…">
        <span>Se connecter</span>
      </button>
    </form>
    <p class="auth-lien-secondaire">
      <button type="button" data-auth-action="methode-email">Recevoir un code par email à la place</button>
    </p>`,

  [ETATS_AUTH.OTP_PENDING]: () => ecranCode(false),
  [ETATS_AUTH.OTP_VERIFYING]: () => ecranCode(true),

  [ETATS_AUTH.AUTH_RESOLVING]: () => `
    <div class="auth-attente" role="status">
      <span class="auth-roue" aria-hidden="true"></span>
      <p id="auth-titre" class="auth-titre" tabindex="-1">Ouverture de votre espace…</p>
    </div>`,

  [ETATS_AUTH.COMPANY_ONBOARDING]: () => {
    const b = flux.brouillon || {};
    return `
      ${entete('Configurez votre entreprise', 'Quatre informations, et votre espace Timora est prêt.')}
      <form class="auth-pile" data-auth-form="onboarding" novalidate>
        <div class="auth-champ">
          <label for="auth-entreprise-nom">Nom de l'entreprise</label>
          <input id="auth-entreprise-nom" name="nom" type="text" autocomplete="organization" required
                 maxlength="120" value="${escapeHtml(b.nom || '')}" placeholder="ex : Kouassi & Fils SARL" />
        </div>
        <div class="auth-grille-2">
          <div class="auth-champ">
            <label for="auth-entreprise-pays">Pays</label>
            <select id="auth-entreprise-pays" name="pays" required autocomplete="country-name">
              ${PAYS_ENTREPRISE.map((p) => `<option value="${escapeHtml(p)}" ${(b.pays || "Côte d'Ivoire") === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
            </select>
          </div>
          <div class="auth-champ">
            <label for="auth-entreprise-ville">Ville</label>
            <input id="auth-entreprise-ville" name="ville" type="text" autocomplete="address-level2" required
                   maxlength="80" value="${escapeHtml(b.ville || '')}" placeholder="ex : Abidjan" />
          </div>
        </div>
        <fieldset class="auth-champ">
          <legend>Nombre approximatif d'employés</legend>
          <div class="auth-puces">
            ${EFFECTIFS_ENTREPRISE.map((e) => `
              <label class="auth-puce">
                <input type="radio" name="effectif" value="${e.valeur}" ${b.effectif === e.valeur ? 'checked' : ''} required />
                <span>${e.libelle}</span>
              </label>`).join('')}
          </div>
        </fieldset>
        ${blocErreur()}
        <button type="submit" class="auth-bouton auth-bouton--principal" data-libelle-attente="Création de votre entreprise…">
          <span>Créer mon espace Timora</span>
        </button>
      </form>`;
  },

  [ETATS_AUTH.NO_MEMBERSHIP]: () => `
    ${entete('Aucune entreprise associée',
      `Le compte <strong>${escapeHtml((state.currentUser && state.currentUser.email) || flux.email || '')}</strong> n'est rattaché à aucune entreprise Timora.`)}
    <div class="auth-pile">
      ${carteChoix('sans-entreprise', 'creer', 'sparkles', 'Créer mon entreprise', 'Je dirige ou je représente une entreprise')}
      ${carteChoix('sans-entreprise', 'rejoindre', 'user-plus', 'Rejoindre mon entreprise', 'J\'ai un code entreprise')}
    </div>
    <p class="auth-lien-secondaire">
      <button type="button" data-auth-action="autre-compte">Utiliser un autre compte</button>
    </p>`,

  [ETATS_AUTH.ERROR]: () => `
    ${entete('Impossible de continuer')}
    ${blocErreur()}
    <div class="auth-pile">
      <button type="button" class="auth-bouton auth-bouton--principal" data-auth-action="reessayer">
        <span>Réessayer</span>
      </button>
    </div>
    <p class="auth-lien-secondaire">
      <button type="button" data-auth-action="autre-compte">Utiliser un autre compte</button>
    </p>`,

  [ETATS_AUTH.AUTHENTICATED]: () => `
    <div class="auth-attente" role="status">
      <span class="auth-succes" aria-hidden="true"><i data-lucide="check" class="w-6 h-6"></i></span>
      <p id="auth-titre" class="auth-titre" tabindex="-1">Bienvenue sur Timora</p>
    </div>`,
};

function ecranCode(verification) {
  const cases = Array.from({ length: OTP_LONGUEUR }, (_, i) => `
    <input class="auth-otp__case" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="${i === 0 ? OTP_LONGUEUR : 1}"
           ${i === 0 ? 'autocomplete="one-time-code"' : 'autocomplete="off"'}
           aria-label="Chiffre ${i + 1} sur ${OTP_LONGUEUR}" data-otp-index="${i}"
           ${verification ? 'disabled' : ''} ${flux.erreur ? 'aria-invalid="true"' : ''} aria-describedby="auth-erreur" />`).join('');

  return `
    ${entete('Vérifiez votre email',
      `Nous avons envoyé un code à <strong class="auth-email-cible">${escapeHtml(flux.email)}</strong>`)}
    <form class="auth-pile" data-auth-form="otp" novalidate>
      <div class="auth-otp" role="group" aria-label="Code de vérification à ${OTP_LONGUEUR} chiffres">${cases}</div>
      <p class="auth-otp__etat" role="status" aria-live="polite">
        ${verification ? '<span class="auth-roue auth-roue--petite" aria-hidden="true"></span> Vérification…' : ''}
      </p>
      ${blocErreur()}
    </form>
    <div class="auth-otp__actions">
      <button type="button" class="auth-lien" data-auth-action="modifier-email" ${verification ? 'disabled' : ''}>
        Modifier l'adresse email
      </button>
      <button type="button" class="auth-lien" data-auth-action="renvoyer-code" id="auth-renvoi" disabled>
        Renvoyer le code
      </button>
    </div>
    <p class="auth-astuce">Rien reçu ? Vérifiez vos courriers indésirables.</p>`;
}

function rendreAuthentification() {
  const conteneur = elementAuth('auth-ecran');
  if (!conteneur) return;

  const ecran = ECRANS_AUTH[flux.etat] || ECRANS_AUTH[ETATS_AUTH.SELECT_PROFILE];
  conteneur.innerHTML = ecran();
  conteneur.setAttribute('data-etat', flux.etat);

  const retour = elementAuth('auth-retour');
  if (retour) {
    // Pendant un envoi, revenir() est de toute facon sans effet : le bouton
    // reste visible pour ne pas disparaitre puis reapparaitre a chaque requete.
    const bloque = [ETATS_AUTH.SELECT_PROFILE, ETATS_AUTH.OTP_VERIFYING,
      ETATS_AUTH.AUTH_RESOLVING, ETATS_AUTH.AUTHENTICATED].includes(flux.etat);
    retour.hidden = bloque || flux.pile.length === 0;
  }

  if (window.lucide) window.lucide.createIcons();

  if (flux.etat === ETATS_AUTH.OTP_PENDING || flux.etat === ETATS_AUTH.OTP_VERIFYING) {
    demarrerMinuteurRenvoi();
  }

  placerFocus();
}

/** Focus utile a chaque ecran : le premier champ a remplir, sinon le titre (annonce aux lecteurs d'ecran). */
function placerFocus() {
  const conteneur = elementAuth('auth-ecran');
  if (!conteneur) return;
  window.requestAnimationFrame(() => {
    let cible = null;
    if (flux.etat === ETATS_AUTH.OTP_PENDING) {
      const cases = conteneur.querySelectorAll('.auth-otp__case');
      cible = Array.prototype.find.call(cases, (c) => !c.value) || cases[cases.length - 1];
    } else if (flux.erreur) {
      cible = conteneur.querySelector('[aria-invalid="true"]');
    }
    cible = cible || conteneur.querySelector('input:not([type="radio"]):not([disabled]), select') || elementAuth('auth-titre');
    if (cible && typeof cible.focus === 'function') cible.focus({ preventScroll: true });
  });
}

function basculerAttente(formulaireOuBouton, enAttente) {
  const bouton = formulaireOuBouton && formulaireOuBouton.tagName === 'FORM'
    ? formulaireOuBouton.querySelector('button[type="submit"]')
    : formulaireOuBouton;
  if (!bouton) return;
  const libelle = bouton.querySelector('span');
  bouton.disabled = enAttente;
  bouton.setAttribute('aria-busy', String(enAttente));
  if (!libelle) return;
  if (enAttente) {
    bouton.dataset.libelleInitial = libelle.textContent;
    libelle.textContent = bouton.dataset.libelleAttente || 'Veuillez patienter…';
  } else if (bouton.dataset.libelleInitial) {
    libelle.textContent = bouton.dataset.libelleInitial;
  }
}

// -----------------------------------------------------------------------------
//  MINUTEUR DE RENVOI
// -----------------------------------------------------------------------------

function demarrerMinuteurRenvoi() {
  arreterMinuteurRenvoi();
  const bouton = elementAuth('auth-renvoi');
  if (!bouton) return;

  const tic = () => {
    const restant = Math.ceil((flux.renvoiPossibleA - Date.now()) / 1000);
    if (restant > 0 && flux.etat !== ETATS_AUTH.OTP_VERIFYING) {
      bouton.disabled = true;
      bouton.textContent = `Renvoyer le code dans ${restant} s`;
    } else {
      bouton.disabled = flux.etat === ETATS_AUTH.OTP_VERIFYING;
      bouton.textContent = 'Renvoyer le code';
      if (restant <= 0) arreterMinuteurRenvoi();
    }
  };
  tic();
  minuteurRenvoi = setInterval(tic, 1000);
}

function arreterMinuteurRenvoi() {
  if (minuteurRenvoi) clearInterval(minuteurRenvoi);
  minuteurRenvoi = null;
}

// -----------------------------------------------------------------------------
//  ETAPES DU PARCOURS
// -----------------------------------------------------------------------------

function choisirProfil(profil) {
  suivreAuth('auth_role_selected', { profil });
  if (profil === 'employe') {
    suivreAuth('employee_join_started');
    allerA(ETATS_AUTH.EMPLOYEE_COMPANY_CODE, { intention: INTENTIONS_AUTH.ADHESION_EMPLOYE });
  } else {
    allerA(ETATS_AUTH.COMPANY_AUTH);
  }
}

function choisirIntentionEntreprise(intention) {
  suivreAuth(intention === INTENTIONS_AUTH.CREATION_ENTREPRISE ? 'company_signup_started' : 'company_login_started');
  flux.intention = intention;
  // Une session est deja ouverte : inutile de s'identifier une seconde fois.
  if (sessionOuverteLocalement()) {
    allerA(ETATS_AUTH.AUTH_RESOLVING);
    resoudreEtOrienter({ intention });
    return;
  }
  allerA(ETATS_AUTH.AUTH_METHOD, { intention });
}

function sessionOuverteLocalement() {
  return !!(state && state.isAuthenticated && state.currentUser && state.currentUser.id);
}

async function verifierCodeEntreprise(formulaire) {
  if (requeteEnCours) return;
  const saisie = String((formulaire.elements.code && formulaire.elements.code.value) || '').trim().toUpperCase();
  flux.entreprise = { code: saisie };

  if (saisie.length < 4) {
    afficherErreur('COMPANY_CODE_INVALID');
    return;
  }
  if (!supabaseClient) {
    afficherErreur('NETWORK_ERROR');
    return;
  }

  requeteEnCours = true;
  basculerAttente(formulaire, true);
  try {
    const { data, error } = await supabaseClient.rpc('lookup_company_by_code', { p_code: saisie });
    if (error) throw error;
    if (!data) {
      afficherErreur('COMPANY_CODE_INVALID');
      return;
    }
    if (['suspended', 'expired', 'cancelled'].includes(String(data.status || '').toLowerCase())) {
      afficherErreur('COMPANY_SUSPENDED');
      return;
    }
    allerA(ETATS_AUTH.EMPLOYEE_COMPANY_CONFIRM, {
      entreprise: { code: saisie, id: data.id, name: data.name, city: data.city || '' },
    });
  } catch (err) {
    afficherErreur(classerErreurAuth(err));
  } finally {
    requeteEnCours = false;
    basculerAttente(formulaire, false);
  }
}

async function envoyerCodeOtp({ renvoi = false, formulaire = null } = {}) {
  if (requeteEnCours) return;

  if (!renvoi) {
    const saisie = String((formulaire && formulaire.elements.email && formulaire.elements.email.value) || '').trim();
    if (!adresseEmailValide(saisie)) {
      flux.email = saisie;
      afficherErreur('EMAIL_INVALID');
      return;
    }
    flux.email = saisie.toLowerCase();
  } else if (Date.now() < flux.renvoiPossibleA) {
    return;
  }

  if (!supabaseClient) {
    afficherErreur('NETWORK_ERROR');
    return;
  }

  requeteEnCours = true;
  if (formulaire) basculerAttente(formulaire, true);
  const boutonRenvoi = elementAuth('auth-renvoi');
  if (renvoi && boutonRenvoi) {
    boutonRenvoi.disabled = true;
    boutonRenvoi.textContent = 'Envoi du code…';
  }

  suivreAuth('otp_requested', { intention: flux.intention, renvoi });
  journaliserAuth('OTP_REQUESTED');

  try {
    // `shouldCreateUser: true` quel que soit le parcours : refuser d'envoyer un
    // code a une adresse inconnue revelerait quelles adresses ont un compte.
    // Un compte sans entreprise est ensuite oriente proprement par le serveur.
    const { error } = await supabaseClient.auth.signInWithOtp({
      email: flux.email,
      options: { shouldCreateUser: true },
    });
    if (error) throw error;

    // L'ecran de saisie ne s'affiche QUE si Supabase a accepte l'envoi.
    journaliserAuth('OTP_SENT');
    const maintenant = Date.now();
    if (renvoi) {
      flux.otpEnvoyeA = maintenant;
      flux.renvoiPossibleA = maintenant + OTP_DELAI_RENVOI_S * 1000;
      flux.erreur = null;
      sauverFlux();
      rendreAuthentification();
      if (typeof showToast === 'function') showToast('Code envoyé ✓', 'Un nouveau code vient de partir. L\'ancien n\'est plus valable.', 'success', 5000);
    } else {
      allerA(ETATS_AUTH.OTP_PENDING, {
        otpEnvoyeA: maintenant,
        renvoiPossibleA: maintenant + OTP_DELAI_RENVOI_S * 1000,
      });
      if (typeof showToast === 'function') showToast('Code envoyé ✓', 'Consultez votre boîte de réception.', 'success', 4000);
    }
  } catch (err) {
    const categorie = classerErreurAuth(err, { envoi: true });
    // Quota du projet epuise : distingue dans le journal, c'est le signal qu'il
    // faut un serveur d'envoi (SMTP) dedie.
    journaliserAuth(['SEND_RATE_LIMITED', 'EMAIL_QUOTA_EXCEEDED'].includes(categorie) ? 'OTP_RATE_LIMITED' : 'OTP_SEND_FAILED',
      { codeErreur: categorie === 'EMAIL_QUOTA_EXCEEDED' ? 'project_email_quota' : (err ? String(err.code || err.status || '') : null) });

    if (categorie === 'SEND_RATE_LIMITED') {
      // Supabase refuse un nouvel envoi : un code valide est donc deja parti.
      // L'utilisateur est conduit a l'ecran de saisie, avec le vrai delai.
      flux.renvoiPossibleA = Date.now() + secondesAvantRenvoi(err) * 1000;
      if (!renvoi) {
        allerA(ETATS_AUTH.OTP_PENDING, {
          otpEnvoyeA: flux.otpEnvoyeA || Date.now(),
          renvoiPossibleA: flux.renvoiPossibleA,
          erreur: 'SEND_RATE_LIMITED',
        });
      } else {
        afficherErreur('SEND_RATE_LIMITED');
      }
    } else {
      afficherErreur(categorie);
    }
  } finally {
    requeteEnCours = false;
    if (formulaire && formulaire.isConnected) basculerAttente(formulaire, false);
  }
}

function lireCodeSaisi() {
  const cases = document.querySelectorAll('#auth-ecran .auth-otp__case');
  return Array.prototype.map.call(cases, (c) => c.value).join('');
}

async function verifierCodeOtp(code) {
  if (requeteEnCours || flux.etat !== ETATS_AUTH.OTP_PENDING) return;
  if (!/^\d{6}$/.test(code)) return;

  requeteEnCours = true;
  flux.etat = ETATS_AUTH.OTP_VERIFYING;
  flux.erreur = null;
  sauverFlux();
  rendreAuthentification();
  // Les chiffres restent visibles pendant la verification.
  remplirCases(code);

  try {
    const { data, error } = await supabaseClient.auth.verifyOtp({ email: flux.email, token: code, type: 'email' });
    if (error) throw error;
    if (!data || !data.session) throw new Error('Session absente après vérification.');

    journaliserAuth('OTP_VERIFIED');
    suivreAuth('otp_verified', { intention: flux.intention });
    if (typeof showToast === 'function') showToast('Email vérifié ✓', 'Ouverture de votre espace…', 'success', 3000);

    requeteEnCours = false;
    allerA(ETATS_AUTH.AUTH_RESOLVING);
    await resoudreEtOrienter({ intention: flux.intention });
  } catch (err) {
    requeteEnCours = false;
    const categorie = classerErreurAuth(err, { otpEnvoyeA: flux.otpEnvoyeA });
    suivreAuth('otp_failed', { raison: categorie });
    journaliserAuth(categorie === 'CODE_EXPIRED' ? 'OTP_EXPIRED' : 'OTP_INVALID', { codeErreur: err ? String(err.code || err.status || '') : null });
    flux.etat = ETATS_AUTH.OTP_PENDING;
    flux.erreur = categorie;
    sauverFlux();
    rendreAuthentification();
    // Code faux : on vide les cases pour une nouvelle saisie immediate.
    if (categorie === 'CODE_INVALID' || categorie === 'CODE_EXPIRED') remplirCases('');
  }
}

function remplirCases(code) {
  const cases = document.querySelectorAll('#auth-ecran .auth-otp__case');
  Array.prototype.forEach.call(cases, (c, i) => { c.value = code[i] || ''; });
}

async function connexionMotDePasse(formulaire) {
  if (requeteEnCours) return;
  const email = String(formulaire.elements.email.value || '').trim().toLowerCase();
  const motDePasse = String(formulaire.elements.motdepasse.value || '');
  flux.email = email;

  if (!adresseEmailValide(email)) {
    afficherErreur('EMAIL_INVALID');
    return;
  }
  if (!motDePasse) {
    afficherErreur('INVALID_CREDENTIALS');
    return;
  }

  requeteEnCours = true;
  basculerAttente(formulaire, true);
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password: motDePasse });
    if (error) throw error;
    if (!data || !data.session) throw new Error('Session absente.');
    requeteEnCours = false;
    allerA(ETATS_AUTH.AUTH_RESOLVING);
    await resoudreEtOrienter({ intention: flux.intention });
  } catch (err) {
    requeteEnCours = false;
    afficherErreur(classerErreurAuth(err));
  } finally {
    if (formulaire.isConnected) basculerAttente(formulaire, false);
  }
}

function lancerGoogle() {
  suivreAuth('auth_google_clicked', { intention: flux.intention });
  journaliserAuth('GOOGLE_STARTED', { email: null });
  sauverFlux();
  // Redirection vers Google ; le parcours (intention, code entreprise) est
  // relu au retour depuis sessionStorage.
  if (typeof connexionGoogle === 'function') connexionGoogle();
}

async function soumettreOnboarding(formulaire) {
  if (requeteEnCours) return;

  const donnees = {
    nom: String(formulaire.elements.nom.value || '').trim(),
    pays: String(formulaire.elements.pays.value || '').trim(),
    ville: String(formulaire.elements.ville.value || '').trim(),
    effectif: (formulaire.querySelector('input[name="effectif"]:checked') || {}).value || '',
  };
  flux.brouillon = donnees;
  sauverFlux();

  const manque = [
    [donnees.nom.length < 2, 'auth-entreprise-nom', 'Indiquez le nom de votre entreprise.'],
    [!donnees.pays, 'auth-entreprise-pays', 'Choisissez un pays.'],
    [donnees.ville.length < 2, 'auth-entreprise-ville', 'Indiquez la ville.'],
    [!donnees.effectif, null, 'Choisissez un effectif.'],
  ].find(([absent]) => absent);

  if (manque) {
    const zone = elementAuth('auth-erreur');
    if (zone) {
      zone.hidden = false;
      zone.innerHTML = `<i data-lucide="alert-circle" class="w-4 h-4" aria-hidden="true"></i><span>${escapeHtml(manque[2])}</span>`;
      if (window.lucide) window.lucide.createIcons();
    }
    const champ = manque[1] ? elementAuth(manque[1]) : formulaire.querySelector('input[name="effectif"]');
    if (champ) {
      if (manque[1]) champ.setAttribute('aria-invalid', 'true');
      champ.focus();
    }
    return;
  }

  // Le bouton reste desactive pendant toute la creation : un double clic ne
  // produit qu'un seul appel. Le serveur protege en plus contre les requetes
  // rejouees (verrou par utilisateur).
  requeteEnCours = true;
  basculerAttente(formulaire, true);
  try {
    const { data, error } = await supabaseClient.rpc('create_company', {
      p_name: donnees.nom,
      p_country: donnees.pays,
      p_city: donnees.ville,
      p_employee_range: donnees.effectif,
    });
    if (error) throw error;

    suivreAuth('company_created', { statut: data.status, effectif: donnees.effectif });
    if (typeof showToast === 'function') {
      if (data.status === 'ALREADY_EXISTS') {
        showToast('Votre entreprise existe déjà', `Vous êtes redirigé vers ${escapeHtml(data.company_name)}.`, 'info', 6000);
      } else {
        showToast('Entreprise créée ✓', `Bienvenue dans l'espace de ${escapeHtml(data.company_name)}.`, 'success', 6000);
      }
    }

    requeteEnCours = false;
    flux.brouillon = {};
    try { localStorage.setItem(CLE_ENTREPRISE_PREFEREE, data.company_id); } catch (err) { /* sans consequence */ }
    allerA(ETATS_AUTH.AUTH_RESOLVING);
    // La destination est redemandee au serveur : c'est lui qui confirme le role.
    await resoudreEtOrienter({ intention: null, entreprisePreferee: data.company_id });
  } catch (err) {
    requeteEnCours = false;
    const categorie = classerErreurAuth(err);
    afficherErreur(categorie === 'UNKNOWN_ERROR' && err && err.code === 'TM422' ? 'UNKNOWN_ERROR' : categorie);
  } finally {
    if (formulaire.isConnected) basculerAttente(formulaire, false);
  }
}

async function rejoindreAvecSession() {
  if (requeteEnCours) return;
  flux.intention = INTENTIONS_AUTH.ADHESION_EMPLOYE;
  allerA(ETATS_AUTH.AUTH_RESOLVING);
  await resoudreEtOrienter({ intention: flux.intention });
}

async function utiliserAutreCompte() {
  try {
    if (supabaseClient) await supabaseClient.auth.signOut();
  } catch (err) {
    /* La deconnexion locale suit de toute facon. */
  }
  if (typeof state !== 'undefined') {
    state.isAuthenticated = false;
    state.currentUser = null;
    state.currentUserRole = null;
    state.currentCompanyId = null;
  }
  try { localStorage.removeItem('winner_auth_session'); } catch (err) { /* sans consequence */ }
  effacerFlux();
  flux.etat = ETATS_AUTH.SELECT_PROFILE;
  sauverFlux();
  rendreAuthentification();
}

// -----------------------------------------------------------------------------
//  RESOLUTION : LA SEULE FONCTION QUI DECIDE DE LA DESTINATION
// -----------------------------------------------------------------------------

/**
 * Demande au serveur qui est l'utilisateur et ou l'envoyer, puis l'y envoie.
 *
 *   intention           choix fait a l'ecran (creation, adhesion)
 *   silencieux          au chargement de page : pas de fenetre ni de message
 *                       si tout est deja coherent
 *   entreprisePreferee  entreprise a ouvrir en priorite (validee par le serveur)
 *
 * Renvoie la destination retenue, ou `null` si la resolution a echoue.
 */
let resolutionEnCours = null;

function resoudreEtOrienter(options = {}) {
  // Une seule resolution a la fois : le demarrage, une garde de navigation et
  // un clic peuvent la demander au meme instant. Sans ce verrou, une adhesion
  // serait deposee deux fois et deux messages de bienvenue s'afficheraient.
  if (resolutionEnCours) return resolutionEnCours;
  resolutionEnCours = executerResolution(options).finally(() => { resolutionEnCours = null; });
  return resolutionEnCours;
}

async function executerResolution({ intention = null, silencieux = false, entreprisePreferee = null, forcerVue = false } = {}) {
  if (!supabaseClient) return null;

  // Adhesion en cours : la demande est deposee AVANT la resolution, pour que
  // le serveur reponde « en attente du RH » plutot que « aucune entreprise ».
  if (intention === INTENTIONS_AUTH.ADHESION_EMPLOYE && flux.entreprise && flux.entreprise.code) {
    try {
      const { error } = await supabaseClient.rpc('join_company', { p_code: flux.entreprise.code });
      if (error) throw error;
    } catch (err) {
      const categorie = classerErreurAuth(err);
      if (!silencieux) {
        ouvrirSiFerme();
        flux.etat = ETATS_AUTH.EMPLOYEE_COMPANY_CODE;
        flux.erreur = categorie;
        sauverFlux();
        rendreAuthentification();
      }
      return null;
    }
  }

  let preferee = entreprisePreferee;
  if (!preferee) {
    try { preferee = localStorage.getItem(CLE_ENTREPRISE_PREFEREE) || null; } catch (err) { preferee = null; }
  }
  if (preferee && !/^[0-9a-f-]{36}$/i.test(preferee)) preferee = null;

  let contexte;
  try {
    const { data, error } = await supabaseClient.rpc('resolve_auth_context', {
      p_intent: fluxServeur(intention),
      p_preferred_company: preferee,
    });
    if (error) throw error;
    contexte = data;
  } catch (err) {
    // 42501 : aucune session valide, la fonction est reservee aux comptes connectes.
    if (err && err.code === '42501') {
      contexte = { authenticated: false };
    } else {
      // Serveur injoignable ou en panne : rien n'est devine, on propose de
      // reessayer. En silence (rechargement), l'etat restaure reste en place.
      if (!silencieux) {
        ouvrirSiFerme();
        flux.etat = ETATS_AUTH.ERROR;
        flux.erreur = classerErreurAuth(err);
        sauverFlux();
        rendreAuthentification();
      }
      return null;
    }
  }

  if (!contexte || !contexte.authenticated) {
    // Session absente ou expiree cote serveur : l'interface ne pretend plus
    // qu'un compte est connecte, et propose de s'identifier.
    if (typeof reinitialiserInterfaceDeconnectee === 'function') {
      reinitialiserInterfaceDeconnectee();
    } else {
      state.isAuthenticated = false;
      state.currentUser = null;
      state.currentUserRole = null;
      try { localStorage.removeItem('winner_auth_session'); } catch (err) { /* sans consequence */ }
    }
    if (!silencieux) {
      ouvrirSiFerme();
      flux.etat = flux.intention ? ETATS_AUTH.AUTH_METHOD : ETATS_AUTH.SELECT_PROFILE;
      flux.erreur = null;
      sauverFlux();
      rendreAuthentification();
    }
    return 'unauthenticated';
  }

  appliquerIdentite(contexte);
  const destination = contexte.destination;
  suivreAuth('auth_redirected', { destination });

  switch (destination) {
    case 'company_dashboard':
    case 'employee_dashboard':
      await entrerDansEspace(contexte, { silencieux, forcerVue });
      break;

    case 'company_onboarding':
      oublierSessionLocale();
      ouvrirSiFerme();
      suivreAuth('company_onboarding_started');
      flux.intention = INTENTIONS_AUTH.CREATION_ENTREPRISE;
      if (!flux.brouillon || !flux.brouillon.nom) {
        const incomplete = (contexte.memberships || []).find((m) => m.role === 'owner' && !m.onboarding_completed);
        flux.brouillon = { ...(flux.brouillon || {}), nom: incomplete ? incomplete.company_name : '' };
      }
      flux.etat = ETATS_AUTH.COMPANY_ONBOARDING;
      flux.erreur = null;
      sauverFlux();
      rendreAuthentification();
      break;

    case 'select_company':
      fermerAuthentification({ oublier: true });
      openSelectWorkspaceModal((contexte.memberships || []).filter((m) =>
        m.status === 'ACTIVE' && !['suspended', 'expired', 'cancelled'].includes(m.company_status)));
      break;

    case 'pending_approval': {
      oublierSessionLocale();
      fermerAuthentification({ oublier: true });
      const attente = contexte.pending || {};
      openPendingApprovalModal(attente);
      break;
    }

    case 'company_suspended':
      oublierSessionLocale();
      ouvrirSiFerme();
      flux.etat = ETATS_AUTH.ERROR;
      flux.erreur = 'COMPANY_SUSPENDED';
      sauverFlux();
      rendreAuthentification();
      break;

    case 'no_membership':
    default:
      oublierSessionLocale();
      if (silencieux) break;
      ouvrirSiFerme();
      flux.etat = ETATS_AUTH.NO_MEMBERSHIP;
      flux.erreur = null;
      sauverFlux();
      rendreAuthentification();
      break;
  }

  return destination;
}

function ouvrirSiFerme() {
  const modale = elementAuth('modal-auth');
  if (modale && modale.hidden) {
    modale.hidden = false;
    document.documentElement.classList.add('auth-ouverte');
  }
}

/** Identite commune a toutes les destinations : qui est connecte, et rien de plus. */
function appliquerIdentite(contexte) {
  const u = contexte.user || {};
  state.isAuthenticated = true;
  state.currentUser = {
    ...(state.currentUser && state.currentUser.id === u.id ? state.currentUser : {}),
    id: u.id,
    email: u.email,
    fullName: u.full_name || (u.email ? u.email.split('@')[0] : ''),
  };
  state.isPlatformAdmin = !!contexte.platform_admin;
  state.userMemberships = contexte.memberships || [];
}

/**
 * Un compte sans espace utilisable ne doit pas etre memorise comme « connecte » :
 * le script de demarrage l'enverrait sinon vers un tableau de bord au rechargement.
 */
function oublierSessionLocale() {
  state.currentUserRole = null;
  state.currentCompanyId = null;
  try { localStorage.removeItem('winner_auth_session'); } catch (err) { /* sans consequence */ }

  // Un espace protege reste parfois affiche derriere la fenetre (memoire
  // locale d'une session precedente, role retire depuis). On en sort : sans
  // rattachement actif, aucune donnee de cet ecran n'est chargeable.
  if (['dashboard', 'employee'].includes(state.activeView) && typeof switchView === 'function') {
    switchView('hero');
  }
}

async function entrerDansEspace(contexte, { silencieux, forcerVue = false }) {
  const actif = contexte.active;
  const role = roleCanonique(actif.role);
  try { localStorage.setItem(CLE_ENTREPRISE_PREFEREE, actif.company_id); } catch (err) { /* sans consequence */ }

  // La vue suit le role : cockpit RH pour le proprietaire, les administrateurs
  // et les managers, espace employe sinon. Une vue demandee avant la connexion
  // (lien vers #dashboard par exemple) n'y deroge pas ; seule la console
  // plateforme est honoree, et seulement pour un administrateur plateforme.
  let vue = estRoleEntreprise(role) ? 'dashboard' : 'employee';
  let voulue = null;
  try {
    voulue = sessionStorage.getItem(CLE_RETOUR_AUTH);
    sessionStorage.removeItem(CLE_RETOUR_AUTH);
  } catch (err) {
    /* Pas de destination memorisee. */
  }
  if (voulue === 'saas' && contexte.platform_admin) vue = 'saas';

  const etaitOuverte = elementAuth('modal-auth') && !elementAuth('modal-auth').hidden;
  if (etaitOuverte) {
    flux.etat = ETATS_AUTH.AUTHENTICATED;
    rendreAuthentification();
  }
  effacerFlux();
  fermerAuthentification({ oublier: true });

  await selectCompanyWorkspace(actif.company_id, role, actif.attendance_required !== false, actif.company_name, {
    // `forcerVue` : la session vient du serveur alors que ce navigateur n'en
    // gardait aucune trace (premiere visite sur cet appareil, stockage vide).
    // Rester sur la page d'accueil laisserait un compte connecte devant la
    // vitrine, sans son espace.
    naviguer: !silencieux || !!voulue || forcerVue || !vueCoherente(role),
    silencieux,
    vue,
  });
}

/**
 * La vue affichee convient-elle deja au role resolu ?
 *
 * Au rechargement, la vue vient de la memoire locale, qui peut etre perimee :
 * un createur d'entreprise memorise EMPLOYEE par l'ancien code est sur
 * l'espace employe, et doit en etre sorti. L'accueil et la console plateforme
 * sont laisses tels quels : l'utilisateur y est venu volontairement.
 */
function vueCoherente(role) {
  const vue = (state && state.activeView) || (window.location.hash || '').replace('#', '').split('?')[0];
  if (vue === 'dashboard') return estRoleEntreprise(role);
  if (vue === 'employee') return !estRoleEntreprise(role);
  return true;
}

// -----------------------------------------------------------------------------
//  SAISIE DU CODE A 6 CHIFFRES
// -----------------------------------------------------------------------------

function gererSaisieCase(caseSaisie) {
  const cases = Array.prototype.slice.call(document.querySelectorAll('#auth-ecran .auth-otp__case'));
  const index = Number(caseSaisie.dataset.otpIndex);
  const chiffres = caseSaisie.value.replace(/\D/g, '');

  if (flux.erreur) {
    flux.erreur = null;
    const zone = elementAuth('auth-erreur');
    if (zone) zone.hidden = true;
    cases.forEach((c) => c.removeAttribute('aria-invalid'));
  }

  if (chiffres.length > 1) {
    // Collage, ou remplissage automatique iOS / Android (« one-time-code ») :
    // la chaine arrive entiere dans une case et se repartit sur les suivantes.
    chiffres.slice(0, OTP_LONGUEUR - index).split('').forEach((ch, i) => { cases[index + i].value = ch; });
    const suivante = cases[Math.min(index + chiffres.length, OTP_LONGUEUR - 1)];
    if (suivante) suivante.focus();
  } else {
    caseSaisie.value = chiffres;
    if (chiffres && cases[index + 1]) cases[index + 1].focus();
  }

  const code = lireCodeSaisi();
  if (/^\d{6}$/.test(code)) verifierCodeOtp(code);
}

function gererToucheCase(evenement) {
  const caseSaisie = evenement.target;
  const cases = Array.prototype.slice.call(document.querySelectorAll('#auth-ecran .auth-otp__case'));
  const index = Number(caseSaisie.dataset.otpIndex);

  if (evenement.key === 'Backspace' && !caseSaisie.value && cases[index - 1]) {
    evenement.preventDefault();
    cases[index - 1].value = '';
    cases[index - 1].focus();
  } else if (evenement.key === 'ArrowLeft' && cases[index - 1]) {
    evenement.preventDefault();
    cases[index - 1].focus();
  } else if (evenement.key === 'ArrowRight' && cases[index + 1]) {
    evenement.preventDefault();
    cases[index + 1].focus();
  }
}

function gererCollage(evenement) {
  const texte = (evenement.clipboardData || window.clipboardData || { getData: () => '' }).getData('text') || '';
  const chiffres = texte.replace(/\D/g, '').slice(0, OTP_LONGUEUR);
  if (!chiffres) return;
  evenement.preventDefault();
  const premiere = document.querySelector('#auth-ecran .auth-otp__case[data-otp-index="0"]');
  if (!premiere) return;
  premiere.value = chiffres;
  gererSaisieCase(premiere);
}

// -----------------------------------------------------------------------------
//  ECOUTEURS (delegation : un seul par type, sur la fenetre d'authentification)
// -----------------------------------------------------------------------------

function brancherAuthentification() {
  const modale = elementAuth('modal-auth');
  if (!modale || modale.dataset.branche === '1') return;
  modale.dataset.branche = '1';

  modale.addEventListener('click', (evenement) => {
    const cible = evenement.target.closest('[data-auth-action]');
    if (!cible || cible.disabled) return;
    const action = cible.dataset.authAction;
    const valeur = cible.dataset.valeur;

    switch (action) {
      case 'fermer': fermerAuthentification(); break;
      case 'retour': revenir(); break;
      case 'profil': choisirProfil(valeur); break;
      case 'intention': choisirIntentionEntreprise(valeur); break;
      case 'connexion-employe':
        flux.intention = INTENTIONS_AUTH.CONNEXION_EMPLOYE;
        allerA(ETATS_AUTH.AUTH_METHOD, { intention: INTENTIONS_AUTH.CONNEXION_EMPLOYE });
        break;
      case 'google': lancerGoogle(); break;
      case 'methode-email':
        suivreAuth('auth_email_started', { intention: flux.intention });
        allerA(ETATS_AUTH.EMAIL_ENTRY);
        break;
      case 'mot-de-passe': allerA(ETATS_AUTH.PASSWORD_ENTRY); break;
      case 'modifier-email':
        arreterMinuteurRenvoi();
        allerA(ETATS_AUTH.EMAIL_ENTRY, { otpEnvoyeA: 0 });
        break;
      case 'renvoyer-code': envoyerCodeOtp({ renvoi: true }); break;
      case 'rejoindre-connecte': rejoindreAvecSession(); break;
      case 'sans-entreprise':
        if (valeur === 'creer') {
          flux.intention = INTENTIONS_AUTH.CREATION_ENTREPRISE;
          suivreAuth('company_onboarding_started');
          allerA(ETATS_AUTH.COMPANY_ONBOARDING, { intention: INTENTIONS_AUTH.CREATION_ENTREPRISE });
        } else {
          allerA(ETATS_AUTH.EMPLOYEE_COMPANY_CODE, { intention: INTENTIONS_AUTH.ADHESION_EMPLOYE });
        }
        break;
      case 'autre-compte': utiliserAutreCompte(); break;
      case 'reessayer':
        allerA(ETATS_AUTH.AUTH_RESOLVING);
        resoudreEtOrienter({ intention: flux.intention });
        break;
      default: break;
    }
  });

  modale.addEventListener('submit', (evenement) => {
    const formulaire = evenement.target.closest('[data-auth-form]');
    if (!formulaire) return;
    evenement.preventDefault();
    switch (formulaire.dataset.authForm) {
      case 'code-entreprise': verifierCodeEntreprise(formulaire); break;
      case 'email': envoyerCodeOtp({ formulaire }); break;
      case 'mot-de-passe': connexionMotDePasse(formulaire); break;
      case 'onboarding': soumettreOnboarding(formulaire); break;
      case 'otp': verifierCodeOtp(lireCodeSaisi()); break;
      default: break;
    }
  });

  modale.addEventListener('input', (evenement) => {
    if (evenement.target.classList.contains('auth-otp__case')) {
      gererSaisieCase(evenement.target);
    } else if (evenement.target.getAttribute('aria-invalid') === 'true') {
      evenement.target.removeAttribute('aria-invalid');
    }
    // Brouillon du formulaire d'entreprise : un rechargement ne le perd pas.
    const formulaire = evenement.target.closest('[data-auth-form="onboarding"]');
    if (formulaire) {
      flux.brouillon = {
        nom: formulaire.elements.nom.value,
        pays: formulaire.elements.pays.value,
        ville: formulaire.elements.ville.value,
        effectif: (formulaire.querySelector('input[name="effectif"]:checked') || {}).value || '',
      };
      sauverFlux();
    }
  });

  modale.addEventListener('change', (evenement) => {
    if (evenement.target.name === 'effectif' || evenement.target.name === 'pays') {
      modale.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  modale.addEventListener('keydown', (evenement) => {
    if (evenement.target.classList && evenement.target.classList.contains('auth-otp__case')) {
      gererToucheCase(evenement);
    }
    // Le focus reste dans la fenetre tant qu'elle est ouverte.
    if (evenement.key === 'Tab') retenirFocus(evenement, modale);
  });

  modale.addEventListener('paste', (evenement) => {
    if (evenement.target.classList && evenement.target.classList.contains('auth-otp__case')) {
      gererCollage(evenement);
    }
  });
}

function retenirFocus(evenement, modale) {
  const focusables = Array.prototype.filter.call(
    modale.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    (el) => !el.hidden && el.offsetParent !== null);
  if (!focusables.length) return;
  const premier = focusables[0];
  const dernier = focusables[focusables.length - 1];
  if (evenement.shiftKey && document.activeElement === premier) {
    evenement.preventDefault();
    dernier.focus();
  } else if (!evenement.shiftKey && document.activeElement === dernier) {
    evenement.preventDefault();
    premier.focus();
  }
}

/**
 * Au chargement : reprend un parcours interrompu par un rechargement, un code
 * en attente de saisie ou un formulaire d'entreprise inacheve.
 *
 * Le retour de Google et les sessions existantes sont traites par le demarrage
 * de app.js, qui appelle `resoudreEtOrienter()`.
 */
function reprendreParcoursAuth({ sessionPresente }) {
  brancherAuthentification();
  const repris = relireFlux();
  if (!repris) return false;

  if (repris.etat === ETATS_AUTH.OTP_PENDING || repris.etat === ETATS_AUTH.OTP_VERIFYING) {
    if (sessionPresente) return false;
    flux = { ...repris, etat: ETATS_AUTH.OTP_PENDING };
    ouvrirSiFerme();
    sauverFlux();
    rendreAuthentification();
    return true;
  }

  if ([ETATS_AUTH.EMAIL_ENTRY, ETATS_AUTH.EMPLOYEE_COMPANY_CODE, ETATS_AUTH.EMPLOYEE_COMPANY_CONFIRM,
       ETATS_AUTH.PASSWORD_ENTRY, ETATS_AUTH.AUTH_METHOD, ETATS_AUTH.COMPANY_AUTH].includes(repris.etat)
      && !sessionPresente) {
    flux = repris;
    ouvrirSiFerme();
    rendreAuthentification();
    return true;
  }

  // Les autres etats (onboarding, resolution) sont repris apres la
  // resolution de la session : c'est le serveur qui dira s'ils ont encore lieu.
  flux = repris;
  return false;
}

/** Intention memorisee par le parcours en cours (lue au retour de Google). */
function intentionParcoursAuth() {
  const repris = relireFlux();
  if (repris) flux = repris;
  return flux.intention;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', brancherAuthentification);
} else {
  brancherAuthentification();
}
