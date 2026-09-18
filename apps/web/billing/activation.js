/* =============================================================================
 *  TIMORA — ACTIVATION DE L'ENTREPRISE (abonnement et paiement)
 * =============================================================================
 *
 *  demonstration -> compte -> entreprise -> CE MODULE -> JoonaPay -> retour
 *  -> verification SERVEUR -> entreprise active -> premiers pas
 *
 *  REGLES
 *  ------
 *   - Ce module n'active RIEN. Il envoie la formule choisie au serveur
 *     (/api/billing/checkout), qui calcule le montant, cree le paiement chez
 *     JoonaPay et renvoie l'adresse de paiement. Au retour, il demande l'etat
 *     au serveur (/api/billing/status), qui le relit chez JoonaPay.
 *   - « Bienvenue sur Timora » ne s'affiche que si le serveur repond COMPLETED.
 *   - Aucun prix n'est ecrit ici : les montants viennent du catalogue
 *     (billing/catalogue.js), le meme que celui du serveur de paiement.
 *   - Aucun secret : seul le jeton de session de l'utilisateur est transmis,
 *     dans l'en-tete Authorization, a nos propres routes.
 * ========================================================================== */

const CLE_FORMULE_CHOISIE = 'timora_formule_choisie';
const CLE_PAIEMENT_EN_COURS = 'timora_paiement_en_cours';
const VERIFICATIONS_MAX = 12;
const INTERVALLE_VERIFICATION_MS = 2500;
const EFFECTIF_VERS_FORMULE = { '1-10': 'essentiel', '11-30': 'business', '31-100': 'pro', '100+': 'entreprise' };

const activation = {
  etat: null,
  contexte: null,
  entreprise: null,       // { id, name, employee_range }
  formule: null,
  periode: 'MONTHLY',
  paiement: null,         // derniere reponse de /api/billing/status
  erreur: null,
  enCours: false,
  verification: 0,
  focusAvant: null,
};

function suivreActivation(nom, donnees = {}) {
  if (typeof suivreTarifs === 'function') suivreTarifs(nom, donnees);
}

const estLocal = () => ['localhost', '127.0.0.1'].includes(window.location.hostname);

/**
 * Traces « [BILLING] » pour suivre le parcours pendant le developpement : en
 * local uniquement, et jamais de cle, de jeton ni de donnee de carte.
 */
function traceFacturation(message, details = null) {
  if (!estLocal()) return;
  console.info(`[BILLING] ${message}`, details || '');
}

/** Badge SANDBOX : en developpement local seulement, jamais montre aux clients. */
function badgeSandbox() {
  const billing = (activation.contexte && activation.contexte.billing) || {};
  const env = (activation.paiement && activation.paiement.environment) || billing.environnement;
  return estLocal() && env === 'sandbox' ? '<span class="activation-sandbox">SANDBOX</span>' : '';
}

const echapActivation = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));

function lireStockage(cle) {
  try {
    const v = sessionStorage.getItem(cle);
    return v ? JSON.parse(v) : null;
  } catch (err) {
    return null;
  }
}

function ecrireStockage(cle, valeur) {
  try {
    if (valeur === null) sessionStorage.removeItem(cle);
    else sessionStorage.setItem(cle, JSON.stringify(valeur));
  } catch (err) {
    /* Navigation privee stricte : le parcours fonctionne sans memoire. */
  }
}

/** Formule choisie sur la page d'accueil, reprise apres la creation du compte. */
function memoriserFormuleChoisie(code, periode) {
  ecrireStockage(CLE_FORMULE_CHOISIE, { code, periode: periode === 'annuel' || periode === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY' });
}

async function jetonSession() {
  if (typeof supabaseClient === 'undefined' || !supabaseClient) return null;
  try {
    const { data } = await supabaseClient.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  } catch (err) {
    return null;
  }
}

async function appelerFacturation(chemin, options = {}) {
  const jeton = await jetonSession();
  if (!jeton) return { status: 401, corps: { code: 'SESSION_REQUISE' } };
  try {
    const r = await fetch(chemin, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${jeton}` },
      cache: 'no-store',
    });
    let corps = null;
    try {
      corps = await r.json();
    } catch (err) {
      corps = null;
    }
    return { status: r.status, corps: corps || {} };
  } catch (err) {
    return { status: 0, corps: { code: 'RESEAU', message: 'Connexion impossible. Vérifiez votre réseau puis réessayez.' } };
  }
}

// -----------------------------------------------------------------------------
//  POINT D'ENTREE DEPUIS LA PAGE D'ACCUEIL
// -----------------------------------------------------------------------------

/**
 * « Activer mon entreprise » : compte, puis entreprise, puis activation. Le
 * parcours d'authentification existant s'en charge ; la resolution serveur
 * ramene ici (destination company_billing_required).
 */
function activerMonEntreprise(source = 'accueil') {
  suivreActivation('activation_cta_clicked', { source });
  if (typeof openAuthModal === 'function') openAuthModal('register');
}

// -----------------------------------------------------------------------------
//  OUVERTURE
// -----------------------------------------------------------------------------

function modaleActivation() {
  return document.getElementById('modal-activation');
}

function afficherModaleActivation() {
  const m = modaleActivation();
  if (!m) return;
  if (m.hidden) activation.focusAvant = document.activeElement;
  m.hidden = false;
  document.documentElement.classList.add('activation-ouverte');
}

function fermerActivation() {
  const m = modaleActivation();
  if (!m || m.hidden) return;
  m.hidden = true;
  document.documentElement.classList.remove('activation-ouverte');
  if (activation.focusAvant && typeof activation.focusAvant.focus === 'function') activation.focusAvant.focus();
}

async function lireEntreprise(companyId) {
  if (!companyId || !supabaseClient) return null;
  try {
    const { data, error } = await supabaseClient
      .from('companies')
      .select('id, name, employee_range')
      .eq('id', companyId)
      .maybeSingle();
    if (error) throw error;
    return data;
  } catch (err) {
    return null;
  }
}

/**
 * Appelee par la resolution d'authentification (company_billing_required), ou
 * depuis le cockpit pour un renouvellement anticipe.
 */
async function ouvrirActivation(contexte, { renouvellement = false } = {}) {
  activation.contexte = contexte || activation.contexte;
  const actif = (activation.contexte && activation.contexte.active) || {};

  // Un retour de paiement est en cours de verification : il garde la main.
  if (['VERIFICATION', 'SUCCES'].includes(activation.etat) && !modaleActivation().hidden) return;

  activation.erreur = null;
  activation.etat = 'CHARGEMENT';
  activation.renouvellement = renouvellement;
  afficherModaleActivation();
  rendreActivation();

  const entreprise = await lireEntreprise(actif.company_id);
  activation.entreprise = entreprise || { id: actif.company_id, name: actif.company_name, employee_range: null };

  if (!prixDisponibles()) {
    activation.etat = 'ERREUR';
    activation.erreur = 'Les tarifs n\'ont pas pu être chargés. Vérifiez votre connexion puis réessayez.';
    rendreActivation();
    return;
  }

  const billing = (activation.contexte && activation.contexte.billing) || {};
  const memorisee = lireStockage(CLE_FORMULE_CHOISIE);
  const recommandee = EFFECTIF_VERS_FORMULE[activation.entreprise.employee_range];
  const precedente = billing.plan && formuleEnLigne(billing.plan) ? billing.plan : null;

  activation.formule = (memorisee && memorisee.code) || precedente || recommandee || 'business';
  activation.periode = (memorisee && memorisee.periode) || 'MONTHLY';
  traceFacturation('billing status', { etat: billing.etat || null, entreprise: actif.company_id || null });

  // Retour sur Timora apres un passage chez JoonaPay, sans adresse de retour
  // (fermeture de l'onglet, developpement local) : le paiement recent est
  // verifie aupres du serveur avant de proposer de payer a nouveau.
  const recent = lireStockage(CLE_PAIEMENT_EN_COURS);
  if (recent && recent.reference && Date.now() - (recent.depuis || 0) < 2 * 3600 * 1000 && !activation.verificationAuto) {
    activation.verificationAuto = true;
    traceFacturation('verification du paiement recent', { reference: recent.reference });
    verifierPaiement(recent.reference);
    return;
  }

  activation.etat = 'CHOIX';
  suivreActivation('activation_viewed', {
    etat_abonnement: billing.etat || null, formule: activation.formule, renouvellement,
  });
  rendreActivation();
}

/** Un collaborateur dont l'entreprise n'a plus d'abonnement actif. */
function ouvrirEntrepriseInactive(contexte) {
  activation.contexte = contexte;
  activation.etat = 'INACTIF';
  afficherModaleActivation();
  rendreActivation();
}

// -----------------------------------------------------------------------------
//  FORMULES
// -----------------------------------------------------------------------------

function formules() {
  return typeof PLANS_TIMORA !== 'undefined' ? PLANS_TIMORA : [];
}

function formuleEnLigne(code) {
  const p = formules().find((f) => f.code === code);
  return p && !p.surDevis && p.mensuel ? p : null;
}

function prixDisponibles() {
  return formules().some((p) => !p.surDevis && p.mensuel);
}

function montantFormule(plan, periode = activation.periode) {
  return periode === 'ANNUAL' ? plan.annuel : plan.mensuel;
}

// -----------------------------------------------------------------------------
//  PAIEMENT
// -----------------------------------------------------------------------------

async function continuerVersPaiement(tentative = 1) {
  // Verrou anti double clic. Les nouveaux essais automatiques (tentative > 1)
  // le detiennent deja : ils passent.
  if (activation.enCours && tentative === 1) return;
  if (activation.formule === 'entreprise') {
    activation.etat = 'DEVIS';
    rendreActivation();
    return;
  }
  const plan = formuleEnLigne(activation.formule);
  if (!plan) return;

  activation.enCours = true;
  activation.erreur = null;
  if (tentative === 1) {
    traceFacturation('selected plan', { plan: plan.code, periode: activation.periode, montant_affiche: montantFormule(plan) });
    suivreActivation('checkout_started', {
      plan: plan.code, periode: activation.periode, montant: montantFormule(plan),
    });
  }
  traceFacturation('checkout requested', { plan: plan.code, periode: activation.periode, tentative });
  rendreActivation();

  const r = await appelerFacturation('/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: plan.code, period: activation.periode }),
  });

  traceFacturation('checkout response', { http_status: r.status, code: r.corps.code || null, reference: r.corps.reference || null });
  if (r.status === 200 && r.corps.checkout_url && /^https:\/\//.test(r.corps.checkout_url)) {
    traceFacturation('checkout url', { reference: r.corps.reference, checkout_url: r.corps.checkout_url, reutilise: !!r.corps.reutilise });
    if (!r.corps.reutilise) suivreActivation('joonapay_checkout_created', { plan: plan.code });
    ecrireStockage(CLE_PAIEMENT_EN_COURS, { reference: r.corps.reference, depuis: Date.now() });
    ecrireStockage(CLE_FORMULE_CHOISIE, null);
    activation.etat = 'REDIRECTION';
    rendreActivation();
    suivreActivation('payment_redirected', { plan: plan.code });
    traceFacturation('redirect started', { vers: new URL(r.corps.checkout_url).host });
    setTimeout(() => window.location.assign(r.corps.checkout_url), 400);
    return;
  }

  activation.enCours = false;

  // Un autre onglet (ou un double clic) prepare deja ce paiement.
  if (r.status === 409 && r.corps.code === 'PAIEMENT_EN_PREPARATION' && tentative < 4) {
    setTimeout(() => continuerVersPaiement(tentative + 1), 2000);
    activation.enCours = true;
    return;
  }
  if (r.status === 401) {
    fermerActivation();
    if (typeof showToast === 'function') showToast('Session expirée', 'Reconnectez-vous pour activer votre entreprise.', 'info', 6000);
    if (typeof openAuthModal === 'function') openAuthModal('company');
    return;
  }
  if (r.status === 409 && r.corps.code === 'DEJA_ACTIF') {
    activation.etat = 'DEJA_ACTIF';
    activation.erreur = r.corps.message;
    rendreActivation();
    return;
  }

  activation.erreur = r.corps.message
    || 'Le paiement n\'a pas pu démarrer. Aucun montant n\'a été débité. Réessayez dans un instant.';
  rendreActivation();
}

// -----------------------------------------------------------------------------
//  RETOUR DE JOONAPAY
// -----------------------------------------------------------------------------

/**
 * Au chargement : l'adresse porte-t-elle un retour de paiement ?
 * (?paiement=retour&ref=TIMORA-SUB-...&issue=annule|echec)
 * Les parametres sont retires de l'adresse aussitot : un rafraichissement ne
 * rejoue rien, et la reference ne reste pas dans l'historique.
 */
function detecterRetourPaiement() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (err) {
    return false;
  }
  if (params.get('paiement') !== 'retour') return false;
  const reference = params.get('ref') || '';
  const issue = params.get('issue');

  const propre = new URL(window.location.href);
  ['paiement', 'ref', 'issue'].forEach((p) => propre.searchParams.delete(p));
  window.history.replaceState(null, '', propre.pathname + propre.search + propre.hash);

  if (!/^TIMORA-SUB-\d{8}-[0-9A-F]{8}$/.test(reference)) return false;
  ecrireStockage(CLE_PAIEMENT_EN_COURS, { reference, depuis: Date.now() });
  suivreActivation('payment_return', { issue: issue || 'succes' });
  activation.issueNavigateur = issue;
  verifierPaiement(reference);
  return true;
}

async function verifierPaiement(reference) {
  activation.etat = 'VERIFICATION';
  activation.reference = reference;
  activation.verification = 0;
  activation.paiement = null;
  afficherModaleActivation();
  rendreActivation();

  while (activation.verification < VERIFICATIONS_MAX && activation.etat === 'VERIFICATION') {
    activation.verification += 1;
    const r = await appelerFacturation(`/api/billing/status?ref=${encodeURIComponent(reference)}`);

    if (r.status === 401) {
      activation.etat = 'CONNEXION';
      rendreActivation();
      return;
    }
    if (r.status === 404 || r.status === 400) {
      activation.etat = 'ERREUR';
      activation.erreur = 'Ce paiement est introuvable pour le compte connecté.';
      rendreActivation();
      return;
    }
    if (r.status === 200) {
      activation.paiement = r.corps;
      const statut = r.corps.status;
      if (statut === 'COMPLETED' && r.corps.subscription && r.corps.subscription.etat === 'ACTIVE') {
        ecrireStockage(CLE_PAIEMENT_EN_COURS, null);
        activation.etat = 'SUCCES';
        suivreActivation('payment_completed', { plan: r.corps.plan, montant: r.corps.amount });
        suivreActivation('subscription_activated', { plan: r.corps.plan });
        rendreActivation();
        return;
      }
      if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(statut)) {
        ecrireStockage(CLE_PAIEMENT_EN_COURS, null);
        activation.etat = statut === 'FAILED' ? 'ECHEC' : statut === 'CANCELLED' ? 'ANNULE' : 'EXPIRE';
        suivreActivation('payment_failed', { statut, plan: r.corps.plan });
        rendreActivation();
        return;
      }
    }
    rendreActivation();
    await new Promise((ok) => setTimeout(ok, INTERVALLE_VERIFICATION_MS));
  }

  if (activation.etat === 'VERIFICATION') {
    activation.etat = 'EN_ATTENTE';
    rendreActivation();
  }
}

async function commencerAvecEntreprise() {
  fermerActivation();
  activation.etat = null;
  suivreActivation('onboarding_started', { source: 'paiement' });
  if (typeof resoudreEtOrienter === 'function') {
    await resoudreEtOrienter({ forcerVue: true });
  }
}

async function seDeconnecterActivation() {
  fermerActivation();
  try {
    if (supabaseClient) await supabaseClient.auth.signOut();
  } catch (err) {
    /* La deconnexion locale suit. */
  }
  if (typeof reinitialiserInterfaceDeconnectee === 'function') reinitialiserInterfaceDeconnectee();
}

// -----------------------------------------------------------------------------
//  RENDU
// -----------------------------------------------------------------------------

function enteteActivation(titre, sousTitre, icone = null) {
  return `
    <div class="auth-tete">
      ${icone || ''}
      <h2 id="activation-titre" class="auth-titre" tabindex="-1">${titre}</h2>
      ${sousTitre ? `<p class="auth-sous-titre">${sousTitre}</p>` : ''}
    </div>`;
}

function blocErreurActivation() {
  if (!activation.erreur) return '';
  return `
    <p class="auth-erreur" role="alert">
      <i data-lucide="alert-circle" class="w-4 h-4" aria-hidden="true"></i>
      <span>${echapActivation(activation.erreur)}</span>
    </p>`;
}

function piedSecurise(total = null) {
  return `
    ${total ? `<p class="activation-rappel-total">Total aujourd'hui : <strong>${echapActivation(total)}</strong></p>` : ''}
    <p class="activation-securite">
      <i data-lucide="lock" class="w-3.5 h-3.5" aria-hidden="true"></i>
      Paiement sécurisé par JoonaPay — Mobile Money ou carte bancaire
    </p>`;
}

function ecranChoixActivation() {
  const billing = (activation.contexte && activation.contexte.billing) || {};
  const expire = billing.etat === 'EXPIRED';
  const nomEntreprise = echapActivation((activation.entreprise && activation.entreprise.name) || 'votre entreprise');
  const recommandee = EFFECTIF_VERS_FORMULE[(activation.entreprise || {}).employee_range];
  const surDevis = activation.formule === 'entreprise';
  const plan = surDevis ? formules().find((p) => p.code === 'entreprise')
    : formuleEnLigne(activation.formule) || formules().find((p) => !p.surDevis && p.mensuel);
  activation.formule = plan.code;
  const montant = surDevis ? null : montantFormule(plan);
  const unite = activation.periode === 'ANNUAL' ? 'an' : 'mois';
  const enCours = lireStockage(CLE_PAIEMENT_EN_COURS);

  let titre = 'Votre espace Timora est presque prêt.';
  let sousTitre = 'Choisissez votre formule pour activer votre entreprise.';
  if (expire) {
    titre = 'Votre abonnement Timora a expiré.';
    sousTitre = 'Vos données sont conservées. Renouvelez votre abonnement pour que vos équipes puissent de nouveau pointer.';
  } else if (billing.etat === 'PAST_DUE') {
    titre = 'Un paiement Timora est en attente.';
    sousTitre = 'Vos données sont conservées. Réglez votre abonnement pour que vos équipes puissent de nouveau pointer.';
  } else if (billing.etat === 'CANCELLED') {
    titre = 'Votre abonnement Timora a été résilié.';
    sousTitre = 'Vos données sont conservées. Choisissez une formule pour réactiver votre entreprise.';
  } else if (activation.renouvellement) {
    titre = 'Renouveler mon abonnement';
    sousTitre = `La nouvelle période s'ajoute à la fin de l'abonnement en cours de <strong>${nomEntreprise}</strong>.`;
  }

  const carteEntreprise = formules().find((p) => p.code === 'entreprise');
  const cartes = formules().filter((p) => !p.surDevis && p.mensuel).map((p) => `
    <label class="activation-formule${p.code === plan.code ? ' is-choisie' : ''}">
      <input type="radio" name="activation-formule" value="${p.code}" ${p.code === plan.code ? 'checked' : ''} data-activation-formule />
      <span class="activation-formule__corps">
        <span class="activation-formule__ligne">
          <strong>${echapActivation(p.nom)}</strong>
          ${p.code === recommandee ? '<span class="activation-pastille">Recommandé</span>'
            : p.badge ? `<span class="activation-pastille is-neutre">${echapActivation(p.badge)}</span>` : ''}
        </span>
        <span class="activation-formule__ligne">
          <span class="activation-formule__cible">Jusqu'à ${p.maxEmployes} employés</span>
          <span class="activation-formule__prix">${echapActivation(formaterFcfa(montantFormule(p)))}<small> / ${unite}</small></span>
        </span>
      </span>
    </label>`).join('') + (carteEntreprise ? `
    <label class="activation-formule${surDevis ? ' is-choisie' : ''}">
      <input type="radio" name="activation-formule" value="entreprise" ${surDevis ? 'checked' : ''} data-activation-formule />
      <span class="activation-formule__corps">
        <span class="activation-formule__ligne">
          <strong>${echapActivation(carteEntreprise.nom)}</strong>
          ${recommandee === 'entreprise' ? '<span class="activation-pastille">Recommandé</span>' : ''}
        </span>
        <span class="activation-formule__ligne">
          <span class="activation-formule__cible">${echapActivation(carteEntreprise.cible)}</span>
          <span class="activation-formule__prix">Sur devis</span>
        </span>
      </span>
    </label>` : '');

  return `
    ${enteteActivation(titre, sousTitre)}
    <p class="activation-entreprise">${badgeSandbox()}<span>${nomEntreprise}</span></p>

    ${enCours && !expire ? `
      <p class="activation-info">
        <i data-lucide="hourglass" class="w-4 h-4" aria-hidden="true"></i>
        <span>Un paiement récent est peut-être en cours de confirmation.
          <button type="button" class="auth-lien" data-activation-action="verifier-recent">Vérifier son état</button></span>
      </p>` : ''}

    <div class="activation-grille">
    <div class="activation-colonne">
    <div class="activation-periode" role="group" aria-label="Période">
      <button type="button" data-activation-periode="MONTHLY" aria-pressed="${activation.periode === 'MONTHLY'}">Mensuel</button>
      <button type="button" data-activation-periode="ANNUAL" aria-pressed="${activation.periode === 'ANNUAL'}">Annuel <small>2 mois offerts</small></button>
    </div>

    <fieldset class="activation-formules">
      <legend class="sr-only">Formule</legend>
      ${cartes}
    </fieldset>
    </div>

    <div class="activation-colonne">
    ${surDevis ? `
    <div class="activation-recap">
      <p class="activation-recap__formule"><strong>ENTREPRISE</strong><span>${echapActivation(plan.cible)} — Sur devis</span></p>
      <p class="activation-recap__note">
        Au-delà de 100 collaborateurs, l'abonnement est établi sur devis selon vos sites et votre organisation.
      </p>
    </div>

    <div class="activation-action">
      <button type="button" class="auth-bouton auth-bouton--principal" data-activation-action="payer">
        <span>Demander un devis</span><i data-lucide="arrow-right" class="w-4 h-4" aria-hidden="true"></i>
      </button>
    </div>` : `
    <div class="activation-recap">
      <p class="activation-recap__formule">
        <strong>${echapActivation(plan.nom.toUpperCase())}</strong>
        <span>${echapActivation(plan.cible)} — ${echapActivation(formaterFcfa(montant))} / ${unite}</span>
      </p>
      <ul>
        ${(plan.principales || []).map((f) => `<li><i data-lucide="check" aria-hidden="true"></i>${echapActivation(f)}</li>`).join('')}
      </ul>
      <div class="activation-total">
        <span>TOTAL AUJOURD'HUI</span>
        <strong>${echapActivation(formaterFcfa(montant))}</strong>
      </div>
      <p class="activation-recap__note">
        ${activation.periode === 'ANNUAL' ? '12 mois' : '1 mois'} d'abonnement. Aucun prélèvement automatique :
        vous renouvelez depuis votre espace, quand vous le décidez.
      </p>
    </div>

    ${blocErreurActivation()}

    <div class="activation-action">
      <button type="button" class="auth-bouton auth-bouton--principal" data-activation-action="payer" ${activation.enCours ? 'disabled' : ''}>
        ${activation.enCours
          ? '<span class="auth-roue auth-roue--petite" aria-hidden="true"></span><span>Préparation du paiement…</span>'
          : `<span>Continuer vers le paiement</span><i data-lucide="arrow-right" class="w-4 h-4" aria-hidden="true"></i>`}
      </button>
      ${piedSecurise(formaterFcfa(montant))}
    </div>`}
    </div>
    </div>`;
}

function ecranDevisActivation() {
  return `
    ${enteteActivation('Formule Entreprise', 'Au-delà de 100 collaborateurs, l\'abonnement est établi sur devis, selon vos sites et votre organisation.')}
    <div class="activation-recap">
      <p class="activation-recap__note">
        Votre entreprise est enregistrée. L'équipe Timora l'active après accord sur le devis.
        En attendant, vous pouvez démarrer tout de suite avec la formule Pro (jusqu'à 100 collaborateurs).
      </p>
    </div>
    <div class="auth-pile">
      <button type="button" class="auth-bouton auth-bouton--principal" data-activation-action="choisir-pro">
        <span>Démarrer avec la formule Pro</span>
      </button>
      <button type="button" class="auth-bouton auth-bouton--secondaire" data-activation-action="fermer">
        <span>Fermer</span>
      </button>
    </div>`;
}

function diagnosticSandbox() {
  const p = activation.paiement;
  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (!local || !p || p.environment !== 'sandbox') return '';
  return `
    <details class="activation-diagnostic">
      <summary>Diagnostic sandbox (visible en local uniquement)</summary>
      <dl>
        <dt>Référence</dt><dd>${echapActivation(p.reference)}</dd>
        <dt>Statut Timora</dt><dd>${echapActivation(p.status)}</dd>
        <dt>Code d'échec</dt><dd>${echapActivation(p.failure_code || '—')}</dd>
        <dt>Dernière lecture JoonaPay</dt><dd>${echapActivation(p.verifie_le || '—')}</dd>
        <dt>Abonnement</dt><dd>${echapActivation((p.subscription && p.subscription.etat) || '—')}</dd>
        <dt>Vérifications</dt><dd>${activation.verification} / ${VERIFICATIONS_MAX}</dd>
      </dl>
    </details>`;
}

function dateLisible(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Abidjan' });
  } catch (err) {
    return '';
  }
}

const ECRANS_ACTIVATION = {
  CHARGEMENT: () => `
    <div class="auth-attente" role="status">
      <span class="auth-roue" aria-hidden="true"></span>
      <p class="auth-sous-titre">Chargement de votre abonnement…</p>
    </div>`,

  CHOIX: ecranChoixActivation,
  DEVIS: ecranDevisActivation,

  REDIRECTION: () => `
    <div class="auth-attente" role="status">
      <span class="auth-roue" aria-hidden="true"></span>
      <h2 id="activation-titre" class="auth-titre" tabindex="-1">Redirection vers le paiement sécurisé…</h2>
      <p class="auth-sous-titre">Vous allez être redirigé vers JoonaPay.</p>
    </div>`,

  VERIFICATION: () => `
    <div class="auth-attente" role="status">
      ${badgeSandbox()}
      <span class="auth-roue" aria-hidden="true"></span>
      <h2 id="activation-titre" class="auth-titre" tabindex="-1">Vérification de votre paiement…</h2>
      <p class="auth-sous-titre">Timora demande la confirmation à JoonaPay. Cela prend quelques secondes.</p>
    </div>
    ${diagnosticSandbox()}`,

  SUCCES: () => {
    const p = activation.paiement || {};
    const plan = formules().find((f) => f.code === p.plan);
    const fin = p.subscription && p.subscription.fin;
    return `
      ${enteteActivation('Bienvenue sur Timora 🎉', 'Votre entreprise est maintenant activée.',
        '<span class="auth-succes" aria-hidden="true"><i data-lucide="party-popper" class="w-6 h-6"></i></span>')}
      <div class="activation-recap">
        <div class="activation-total">
          <span>${echapActivation(plan ? `Formule ${plan.nom}` : 'Abonnement')}</span>
          <strong>${echapActivation(formaterFcfa(p.amount || 0))}</strong>
        </div>
        ${fin ? `<p class="activation-recap__note">Actif jusqu'au ${echapActivation(dateLisible(fin))}.</p>` : ''}
      </div>
      <button type="button" class="auth-bouton auth-bouton--principal" data-activation-action="commencer">
        <span>Configurer mon entreprise</span>
        <i data-lucide="arrow-right" class="w-4 h-4" aria-hidden="true"></i>
      </button>
      ${diagnosticSandbox()}`;
  },

  ECHEC: () => `
    ${enteteActivation('Le paiement n\'a pas abouti', 'Aucun abonnement n\'a été activé et rien ne vous a été facturé par Timora. Vous pouvez réessayer, avec le même moyen de paiement ou un autre.')}
    <div class="auth-pile">
      <button type="button" class="auth-bouton auth-bouton--principal" data-activation-action="reessayer">
        <span>Réessayer le paiement</span>
      </button>
    </div>
    ${diagnosticSandbox()}`,

  ANNULE: () => `
    ${enteteActivation('Paiement annulé', 'Votre entreprise n\'est pas encore activée. Vous pouvez reprendre quand vous le souhaitez.')}
    <div class="auth-pile">
      <button type="button" class="auth-bouton auth-bouton--principal" data-activation-action="reessayer">
        <span>Reprendre l'activation</span>
      </button>
    </div>
    ${diagnosticSandbox()}`,

  EXPIRE: () => `
    ${enteteActivation('Le délai de paiement est dépassé', 'Ce lien de paiement n\'est plus valable. Relancez l\'activation pour en obtenir un nouveau.')}
    <div class="auth-pile">
      <button type="button" class="auth-bouton auth-bouton--principal" data-activation-action="reessayer">
        <span>Relancer l'activation</span>
      </button>
    </div>
    ${diagnosticSandbox()}`,

  EN_ATTENTE: () => {
    const p = activation.paiement || {};
    return `
      ${enteteActivation('Votre paiement est toujours en cours de vérification.',
        activation.issueNavigateur === 'annule'
          ? 'Vous avez quitté la page de paiement. Si vous avez tout de même payé, votre entreprise sera activée dès la confirmation de JoonaPay.'
          : 'Dès que JoonaPay le confirme, votre entreprise est activée automatiquement. Vous pouvez fermer cette page.')}
      <div class="auth-pile">
        <button type="button" class="auth-bouton auth-bouton--principal" data-activation-action="verifier">
          <span>Vérifier à nouveau</span>
        </button>
        ${p.checkout_url && /^https:\/\//.test(p.checkout_url) ? `
          <a class="auth-bouton auth-bouton--secondaire" href="${echapActivation(p.checkout_url)}" rel="noopener">
            <span>Reprendre le paiement</span>
          </a>` : ''}
      </div>
      <p class="auth-lien-secondaire">
        <button type="button" data-activation-action="changer">Choisir une autre formule</button>
      </p>
      ${diagnosticSandbox()}`;
  },

  CONNEXION: () => `
    ${enteteActivation('Connectez-vous pour voir votre paiement', 'Utilisez le compte avec lequel vous avez lancé le paiement : Timora vous montrera son état.')}
    <button type="button" class="auth-bouton auth-bouton--principal" data-activation-action="connexion">
      <span>Me connecter</span>
    </button>`,

  DEJA_ACTIF: () => `
    ${enteteActivation('Votre abonnement est déjà actif', echapActivation(activation.erreur || ''))}
    <button type="button" class="auth-bouton auth-bouton--principal" data-activation-action="commencer">
      <span>Ouvrir mon espace</span>
    </button>`,

  INACTIF: () => {
    const actif = (activation.contexte && activation.contexte.active) || {};
    return `
      ${enteteActivation(`L'abonnement Timora de ${echapActivation(actif.company_name || 'votre entreprise')} n'est pas actif`,
        'Vos pointages reprendront dès que votre responsable aura renouvelé l\'abonnement. Vos données sont conservées.')}
      <div class="auth-pile">
        <button type="button" class="auth-bouton auth-bouton--secondaire" data-activation-action="deconnexion">
          <span>Se déconnecter</span>
        </button>
      </div>`;
  },

  ERREUR: () => `
    ${enteteActivation('Impossible de continuer')}
    ${blocErreurActivation()}
    <button type="button" class="auth-bouton auth-bouton--principal" data-activation-action="recharger">
      <span>Réessayer</span>
    </button>`,
};

function rendreActivation() {
  const zone = document.getElementById('activation-ecran');
  if (!zone || !activation.etat) return;
  const changement = zone.dataset.etat !== activation.etat;
  zone.dataset.etat = activation.etat;
  zone.innerHTML = (ECRANS_ACTIVATION[activation.etat] || ECRANS_ACTIVATION.ERREUR)();
  // Ecran de choix : deux colonnes sur ordinateur (formules | recapitulatif).
  const carte = zone.closest('.activation-carte');
  if (carte) carte.classList.toggle('is-large', activation.etat === 'CHOIX');
  if (window.lucide) window.lucide.createIcons();
  if (changement) {
    const titre = document.getElementById('activation-titre');
    if (titre) titre.focus({ preventScroll: true });
  }
}

// -----------------------------------------------------------------------------
//  PREMIERS PAS (cockpit, apres activation)
// -----------------------------------------------------------------------------
//
//  Cinq etapes, mesurees en base (company_onboarding_progress), jusqu'au
//  premier pointage reel. Chaque etape renvoie vers l'ecran existant qui la
//  realise : rien n'est duplique ici.

const CLE_DEMARRAGE = 'timora_demarrage_';

function lireDemarrage(companyId) {
  try {
    return JSON.parse(localStorage.getItem(CLE_DEMARRAGE + companyId) || '{}');
  } catch (err) {
    return {};
  }
}

function ecrireDemarrage(companyId, valeur) {
  try {
    localStorage.setItem(CLE_DEMARRAGE + companyId, JSON.stringify(valeur));
  } catch (err) {
    /* Sans memoire locale, les evenements peuvent etre signales deux fois. */
  }
}

/** Signale une etape franchie une seule fois par entreprise et par appareil. */
function signalerEtape(companyId, memoire, cle, evenement) {
  if (memoire[cle]) return;
  memoire[cle] = true;
  suivreActivation(evenement, { company: companyId });
}

async function afficherDemarrage(companyId) {
  const hote = document.getElementById('demarrage-timora');
  if (!hote || !companyId || !supabaseClient) return;

  let p;
  try {
    const { data, error } = await supabaseClient.rpc('company_onboarding_progress', { p_company: companyId });
    if (error) throw error;
    p = data;
  } catch (err) {
    p = null;
  }
  // Progression illisible (droits, reseau, base pas encore migree) : le
  // cockpit s'affiche normalement, sans bloc de premiers pas.
  if (!p || typeof p !== 'object') {
    hote.hidden = true;
    return;
  }

  const memoire = lireDemarrage(companyId);
  const abo = p.abonnement || {};
  if (p.zones > 0) signalerEtape(companyId, memoire, 'zone', 'company_configured');
  if (p.employes_actifs > 0) signalerEtape(companyId, memoire, 'employe', 'first_employee_joined');
  if (p.pointages > 0) signalerEtape(companyId, memoire, 'pointage', 'first_attendance_completed');

  const etapes = [
    { fait: abo.etat === 'ACTIVE', titre: 'Abonnement activé',
      texte: abo.fin ? `Actif jusqu'au ${dateLisible(abo.fin)}.` : 'Votre entreprise est active.' },
    { fait: p.zones > 0, titre: 'Définir votre zone de pointage',
      texte: 'L\'adresse et le rayon où vos équipes peuvent pointer.', action: 'zone', bouton: 'Créer ma zone' },
    { fait: p.employes_actifs + p.demandes > 0, titre: 'Inviter vos collaborateurs',
      texte: `Partagez le code ${echapActivation(p.code_entreprise || '')} : chacun le saisit depuis son téléphone.`, action: 'code', bouton: 'Partager le code' },
    { fait: p.employes_actifs > 0, titre: 'Accepter leurs demandes',
      texte: p.demandes > 0 ? `${p.demandes} demande${p.demandes > 1 ? 's' : ''} en attente.` : 'Les demandes apparaissent ici dès qu\'un collaborateur saisit le code.',
      action: p.demandes > 0 ? 'demandes' : null, bouton: 'Voir les demandes' },
    { fait: p.pointages > 0, titre: 'Premier pointage',
      texte: 'Vos collaborateurs ouvrent Timora sur leur téléphone et appuient sur « Pointer ».' },
  ];
  const faites = etapes.filter((e) => e.fait).length;

  // Tout est fait, ou masque par l'utilisateur : le cockpit reprend sa place.
  const finRenouvellement = abo.fin && !abo.heritee
    && new Date(abo.fin).getTime() - Date.now() < 7 * 86400000;
  if ((faites === etapes.length || memoire.masque) && !finRenouvellement) {
    ecrireDemarrage(companyId, memoire);
    hote.hidden = true;
    return;
  }
  if (!memoire.vu) {
    memoire.vu = true;
    suivreActivation('onboarding_started', { company: companyId, source: 'cockpit' });
  }
  ecrireDemarrage(companyId, memoire);

  hote.innerHTML = `
    ${finRenouvellement ? `
      <div class="demarrage-alerte" role="status">
        <i data-lucide="calendar-clock" class="w-4 h-4" aria-hidden="true"></i>
        <span>Votre abonnement se termine le <strong>${echapActivation(dateLisible(abo.fin))}</strong>.</span>
        <button type="button" data-demarrage-action="renouveler">Renouveler</button>
      </div>` : ''}
    ${faites === etapes.length || memoire.masque ? '' : `
      <div class="demarrage-entete">
        <div>
          <h3>Premiers pas avec Timora</h3>
          <p>${faites} étape${faites > 1 ? 's' : ''} sur ${etapes.length} — objectif : le premier pointage de votre équipe.</p>
        </div>
        <button type="button" class="demarrage-masquer" data-demarrage-action="masquer" aria-label="Masquer les premiers pas">
          <i data-lucide="x" class="w-4 h-4" aria-hidden="true"></i>
        </button>
      </div>
      <div class="demarrage-barre" role="progressbar" aria-valuemin="0" aria-valuemax="${etapes.length}" aria-valuenow="${faites}">
        <span style="width: ${Math.round((faites / etapes.length) * 100)}%"></span>
      </div>
      <ol class="demarrage-etapes">
        ${etapes.map((e, i) => `
          <li class="${e.fait ? 'is-faite' : ''}">
            <span class="demarrage-puce" aria-hidden="true">${e.fait ? '<i data-lucide="check"></i>' : i + 1}</span>
            <span class="demarrage-texte"><strong>${e.titre}</strong><small>${e.texte}</small></span>
            ${!e.fait && e.action ? `<button type="button" data-demarrage-action="${e.action}">${e.bouton}</button>` : ''}
          </li>`).join('')}
      </ol>`}`;
  hote.hidden = false;
  hote.dataset.company = companyId;
  if (window.lucide) window.lucide.createIcons();
}

// -----------------------------------------------------------------------------
//  EVENEMENTS
// -----------------------------------------------------------------------------

function initialiserActivation() {
  const m = modaleActivation();
  if (m) {
    m.addEventListener('click', (e) => {
      const cible = e.target.closest('[data-activation-action], [data-activation-periode]');
      if (!cible) return;
      if (cible.dataset.activationPeriode) {
        activation.periode = cible.dataset.activationPeriode;
        rendreActivation();
        return;
      }
      const action = cible.dataset.activationAction;
      if (action === 'fermer') fermerActivation();
      else if (action === 'payer') continuerVersPaiement();
      else if (action === 'devis') { activation.etat = 'DEVIS'; rendreActivation(); }
      else if (action === 'choisir-pro') { activation.formule = 'pro'; activation.etat = 'CHOIX'; rendreActivation(); }
      else if (action === 'reessayer') ouvrirActivation(activation.contexte);
      else if (action === 'recharger') ouvrirActivation(activation.contexte);
      else if (action === 'verifier') verifierPaiement(activation.reference);
      else if (action === 'changer') {
        ecrireStockage(CLE_PAIEMENT_EN_COURS, null);
        ouvrirActivation(activation.contexte);
      }
      else if (action === 'verifier-recent') {
        const enCours = lireStockage(CLE_PAIEMENT_EN_COURS);
        if (enCours && enCours.reference) verifierPaiement(enCours.reference);
      } else if (action === 'commencer') commencerAvecEntreprise();
      else if (action === 'deconnexion') seDeconnecterActivation();
      else if (action === 'connexion') {
        fermerActivation();
        if (typeof openAuthModal === 'function') openAuthModal('company');
      }
    });

    m.addEventListener('change', (e) => {
      const radio = e.target.closest('[data-activation-formule]');
      if (!radio) return;
      activation.formule = radio.value;
      traceFacturation('selected plan', { plan: radio.value });
      suivreActivation('plan_selected', { plan: radio.value, source: 'activation' });
      rendreActivation();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !m.hidden && !['REDIRECTION', 'VERIFICATION'].includes(activation.etat)) fermerActivation();
    });
  }

  const hote = document.getElementById('demarrage-timora');
  if (hote) {
    hote.addEventListener('click', async (e) => {
      const cible = e.target.closest('[data-demarrage-action]');
      if (!cible) return;
      const companyId = hote.dataset.company;
      const action = cible.dataset.demarrageAction;
      if (action === 'zone' && typeof openSiteForm === 'function') openSiteForm();
      else if (action === 'code' && typeof openCompanyQrModal === 'function') openCompanyQrModal();
      else if (action === 'demandes' && typeof switchSection === 'function') switchSection('pending-approvals');
      else if (action === 'masquer') {
        const memoire = lireDemarrage(companyId);
        memoire.masque = true;
        ecrireDemarrage(companyId, memoire);
        hote.hidden = true;
      } else if (action === 'renouveler') {
        const p = await (async () => {
          try {
            const { data } = await supabaseClient.rpc('company_onboarding_progress', { p_company: companyId });
            return data;
          } catch (err) {
            return null;
          }
        })();
        ouvrirActivation({
          active: { company_id: companyId, company_name: state.currentCompanyName || '' },
          billing: (p && p.abonnement) || {},
        }, { renouvellement: true });
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialiserActivation);
} else {
  initialiserActivation();
}
