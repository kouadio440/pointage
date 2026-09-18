/* =============================================================================
 *  TIMORA — AVIS DES UTILISATEURS
 * =============================================================================
 *
 *  Section « Ce que les utilisateurs pensent de Timora » de la page d'accueil,
 *  formulaire « Donner mon avis » et moderation dans la console plateforme.
 *
 *  REGLES
 *  ------
 *   - Uniquement de vrais avis : deposes par un compte connecte, publies apres
 *     validation par l'equipe Timora (migration 032). Aucune note, aucun nom,
 *     aucun temoignage n'est ecrit dans ce fichier.
 *   - La note moyenne n'est affichee que si le serveur la fournit (a partir de
 *     3 avis publies). Sans avis : une invitation, jamais un chiffre invente.
 *   - Tout texte venant de la base est echappe avant affichage.
 * ========================================================================== */

const CLE_AVIS_APRES_CONNEXION = 'timora_avis_apres_connexion';

const avisPublics = {
  donnees: null,
  erreur: false,
  charge: false,
};

const formulaireAvis = {
  etat: null,          // CHARGEMENT | FORMULAIRE | MERCI | ERREUR
  existant: null,      // reponse de my_review()
  envoi: false,
  erreur: null,
  focusAvant: null,
};

const moderationAvis = { filtre: 'PENDING', donnees: null, enCours: false };

const echapAvis = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));

function suivreAvis(nom, donnees = {}) {
  if (typeof suivreTarifs === 'function') suivreTarifs(nom, donnees);
}

function etoiles(note) {
  const n = Math.max(0, Math.min(5, Number(note) || 0));
  return `<span class="avis-etoiles" role="img" aria-label="Note : ${n} sur 5">${'★'.repeat(n)}<span class="avis-etoiles__vide">${'★'.repeat(5 - n)}</span></span>`;
}

function dateAvis(iso) {
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'Africa/Abidjan' });
  } catch (err) {
    return '';
  }
}

// -----------------------------------------------------------------------------
//  AFFICHAGE PUBLIC
// -----------------------------------------------------------------------------

async function chargerAvis() {
  if (typeof supabaseClient === 'undefined' || !supabaseClient) {
    avisPublics.erreur = true;
    rendreAvis();
    return;
  }
  try {
    const { data, error } = await supabaseClient.rpc('reviews_public', { p_limit: 12 });
    if (error) throw error;
    avisPublics.donnees = data || { nombre: 0, avis: [] };
    avisPublics.erreur = false;
  } catch (err) {
    avisPublics.erreur = true;
  }
  avisPublics.charge = true;
  rendreAvis();
}

function rendreAvis() {
  const liste = document.getElementById('avis-liste');
  const resume = document.getElementById('avis-resume');
  if (!liste) return;

  if (avisPublics.erreur) {
    if (resume) resume.textContent = '';
    liste.innerHTML = `
      <div class="avis__vide" role="status">
        <p>Les avis ne peuvent pas être affichés pour le moment.</p>
        <button type="button" class="avis__lien" data-avis-action="recharger">Réessayer</button>
      </div>`;
    return;
  }

  const d = avisPublics.donnees || { nombre: 0, avis: [] };
  if (!d.nombre || !d.avis || !d.avis.length) {
    if (resume) resume.textContent = '';
    liste.innerHTML = `
      <div class="avis__vide">
        <i data-lucide="message-square-heart" class="avis__vide-icone" aria-hidden="true"></i>
        <p><strong>Soyez parmi les premiers à partager votre expérience.</strong></p>
        <p>Les avis sont publiés après vérification par l'équipe Timora.</p>
      </div>`;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  if (resume) {
    const moyenne = d.moyenne !== null && d.moyenne !== undefined
      ? `${String(Number(d.moyenne).toFixed(1)).replace('.', ',')} / 5 · ` : '';
    resume.textContent = `${moyenne}${d.nombre} avis vérifié${d.nombre > 1 ? 's' : ''} par l'équipe Timora`;
  }

  liste.innerHTML = d.avis.map((a) => `
    <article class="avis-carte" role="listitem">
      <div class="avis-carte__tete">
        ${etoiles(a.note)}
        ${a.client_verifie ? '<span class="avis-badge"><i data-lucide="badge-check" aria-hidden="true"></i>Client Timora</span>' : ''}
      </div>
      ${a.titre ? `<h3 class="avis-carte__titre">${echapAvis(a.titre)}</h3>` : ''}
      <p class="avis-carte__texte">${echapAvis(a.texte)}</p>
      <p class="avis-carte__auteur">
        <strong>${echapAvis(a.auteur)}</strong>
        ${a.entreprise ? `<span>${echapAvis(a.entreprise)}</span>` : ''}
        <span>${echapAvis(dateAvis(a.date))}</span>
      </p>
    </article>`).join('');
  if (window.lucide) window.lucide.createIcons();
}

// -----------------------------------------------------------------------------
//  DEPOSER UN AVIS
// -----------------------------------------------------------------------------

function donnerMonAvis() {
  suivreAvis('review_cta_clicked', { connecte: !!(typeof state !== 'undefined' && state.isAuthenticated) });
  if (typeof state === 'undefined' || !state.isAuthenticated) {
    // L'avis est depose par un compte identifie : connexion d'abord, puis le
    // formulaire s'ouvre de lui-meme (reprendreAvisApresConnexion).
    try { sessionStorage.setItem(CLE_AVIS_APRES_CONNEXION, '1'); } catch (err) { /* sans consequence */ }
    if (typeof openAuthModal === 'function') openAuthModal('login');
    return;
  }
  ouvrirFormulaireAvis();
}

/** Appelee apres chaque resolution d'authentification reussie. */
function reprendreAvisApresConnexion() {
  let demande = null;
  try { demande = sessionStorage.getItem(CLE_AVIS_APRES_CONNEXION); } catch (err) { demande = null; }
  if (!demande || typeof state === 'undefined' || !state.isAuthenticated) return;
  try { sessionStorage.removeItem(CLE_AVIS_APRES_CONNEXION); } catch (err) { /* sans consequence */ }
  ouvrirFormulaireAvis();
}

function modaleAvis() {
  return document.getElementById('modal-avis');
}

async function ouvrirFormulaireAvis() {
  const m = modaleAvis();
  if (!m) return;
  if (m.hidden) formulaireAvis.focusAvant = document.activeElement;
  m.hidden = false;
  document.documentElement.classList.add('avis-ouvert');
  formulaireAvis.etat = 'CHARGEMENT';
  formulaireAvis.erreur = null;
  rendreFormulaireAvis();

  try {
    const { data, error } = await supabaseClient.rpc('my_review');
    if (error) throw error;
    formulaireAvis.existant = data || {};
    formulaireAvis.etat = 'FORMULAIRE';
  } catch (err) {
    formulaireAvis.etat = 'ERREUR';
    formulaireAvis.erreur = 'Le formulaire ne peut pas être ouvert pour le moment. Réessayez dans un instant.';
  }
  rendreFormulaireAvis();
}

function fermerFormulaireAvis() {
  const m = modaleAvis();
  if (!m || m.hidden) return;
  m.hidden = true;
  document.documentElement.classList.remove('avis-ouvert');
  if (formulaireAvis.focusAvant && typeof formulaireAvis.focusAvant.focus === 'function') formulaireAvis.focusAvant.focus();
}

const MESSAGES_STATUT_AVIS = {
  PENDING: 'Votre avis est en attente de vérification.',
  APPROVED: 'Votre avis est publié. Le modifier le soumettra de nouveau à vérification.',
  REJECTED: 'Votre avis n\'a pas été publié. Vous pouvez le modifier.',
};

function rendreFormulaireAvis() {
  const zone = document.getElementById('avis-ecran');
  if (!zone) return;
  const changement = zone.dataset.etat !== formulaireAvis.etat;
  zone.dataset.etat = formulaireAvis.etat;

  if (formulaireAvis.etat === 'CHARGEMENT') {
    zone.innerHTML = `
      <div class="auth-attente" role="status">
        <span class="auth-roue" aria-hidden="true"></span>
        <p class="auth-sous-titre">Chargement…</p>
      </div>`;
  } else if (formulaireAvis.etat === 'MERCI') {
    zone.innerHTML = `
      <div class="auth-tete">
        <span class="auth-succes" aria-hidden="true"><i data-lucide="heart-handshake" class="w-6 h-6"></i></span>
        <h2 id="avis-form-titre" class="auth-titre" tabindex="-1">Merci pour votre avis !</h2>
        <p class="auth-sous-titre">Il sera publié après vérification par l'équipe Timora.</p>
      </div>
      <button type="button" class="auth-bouton auth-bouton--principal" data-avis-action="fermer"><span>Fermer</span></button>`;
  } else if (formulaireAvis.etat === 'ERREUR') {
    zone.innerHTML = `
      <div class="auth-tete"><h2 id="avis-form-titre" class="auth-titre" tabindex="-1">Donner mon avis</h2></div>
      <p class="auth-erreur" role="alert"><i data-lucide="alert-circle" class="w-4 h-4" aria-hidden="true"></i><span>${echapAvis(formulaireAvis.erreur)}</span></p>
      <button type="button" class="auth-bouton auth-bouton--principal" data-avis-action="donner"><span>Réessayer</span></button>`;
  } else {
    const ex = (formulaireAvis.existant && formulaireAvis.existant.avis) || null;
    const entreprise = formulaireAvis.existant && formulaireAvis.existant.entreprise;
    const note = ex ? ex.note : 0;
    zone.innerHTML = `
      <div class="auth-tete">
        <h2 id="avis-form-titre" class="auth-titre" tabindex="-1">Donner mon avis</h2>
        <p class="auth-sous-titre">Votre avis sera publié après vérification par l'équipe Timora.</p>
      </div>
      ${ex ? `<p class="activation-info"><i data-lucide="info" class="w-4 h-4" aria-hidden="true"></i><span>${echapAvis(MESSAGES_STATUT_AVIS[ex.statut] || '')}</span></p>` : ''}
      <form class="auth-pile" data-avis-form novalidate>
        <fieldset class="auth-champ avis-note">
          <legend>Votre note</legend>
          <div class="avis-note__etoiles">
            ${[5, 4, 3, 2, 1].map((n) => `
              <input type="radio" id="avis-note-${n}" name="note" value="${n}" ${note === n ? 'checked' : ''} />
              <label for="avis-note-${n}" title="${n} sur 5"><span class="sr-only">${n} étoile${n > 1 ? 's' : ''} sur 5</span>★</label>`).join('')}
          </div>
        </fieldset>
        <div class="auth-champ">
          <label for="avis-titre-champ">Titre <span class="avis-facultatif">(facultatif)</span></label>
          <input id="avis-titre-champ" name="titre" type="text" maxlength="80" autocomplete="off"
                 value="${echapAvis(ex && ex.titre ? ex.titre : '')}" placeholder="ex : Plus de fraude au pointage" />
        </div>
        <div class="auth-champ">
          <label for="avis-texte-champ">Votre avis</label>
          <textarea id="avis-texte-champ" name="texte" rows="5" minlength="20" maxlength="1000" required
                    placeholder="Qu'est-ce que Timora a changé pour votre équipe ?">${echapAvis(ex ? ex.texte : '')}</textarea>
          <span class="avis-compteur" data-avis-compteur aria-live="polite">${(ex ? ex.texte.length : 0)} / 1000</span>
        </div>
        ${entreprise ? `
          <label class="avis-case">
            <input type="checkbox" name="entreprise" ${ex && ex.afficher_entreprise ? 'checked' : ''} />
            <span>Afficher le nom de mon entreprise (${echapAvis(entreprise)})</span>
          </label>` : ''}
        ${formulaireAvis.erreur ? `<p class="auth-erreur" role="alert"><i data-lucide="alert-circle" class="w-4 h-4" aria-hidden="true"></i><span>${echapAvis(formulaireAvis.erreur)}</span></p>` : ''}
        <button type="submit" class="auth-bouton auth-bouton--principal" ${formulaireAvis.envoi ? 'disabled' : ''}>
          ${formulaireAvis.envoi ? '<span class="auth-roue auth-roue--petite" aria-hidden="true"></span><span>Envoi…</span>' : '<span>Publier mon avis</span>'}
        </button>
      </form>`;
  }
  if (window.lucide) window.lucide.createIcons();
  if (changement) {
    const titre = document.getElementById('avis-form-titre');
    if (titre) titre.focus({ preventScroll: true });
  }
}

async function envoyerAvis(formulaire) {
  if (formulaireAvis.envoi) return;
  const donnees = new FormData(formulaire);
  const note = Number(donnees.get('note'));
  const titre = String(donnees.get('titre') || '').trim();
  const texte = String(donnees.get('texte') || '').trim();

  if (!note) {
    formulaireAvis.erreur = 'Choisissez une note de 1 à 5 étoiles.';
  } else if (texte.length < 20) {
    formulaireAvis.erreur = 'Votre avis doit faire au moins 20 caractères.';
  } else {
    formulaireAvis.erreur = null;
  }
  if (formulaireAvis.erreur) {
    formulaireAvis.existant = { ...(formulaireAvis.existant || {}), avis: { ...((formulaireAvis.existant || {}).avis || {}), note, titre, texte, statut: ((formulaireAvis.existant || {}).avis || {}).statut } };
    rendreFormulaireAvis();
    return;
  }

  formulaireAvis.envoi = true;
  rendreFormulaireAvis();
  try {
    const { error } = await supabaseClient.rpc('submit_review', {
      p_rating: note,
      p_title: titre || null,
      p_body: texte,
      p_show_company: donnees.get('entreprise') === 'on',
    });
    if (error) throw error;
    formulaireAvis.envoi = false;
    formulaireAvis.etat = 'MERCI';
    suivreAvis('review_submitted', { note });
    rendreFormulaireAvis();
  } catch (err) {
    formulaireAvis.envoi = false;
    // Messages de la base : en francais, destines a l'utilisateur.
    const connu = err && (err.hint || /^TM|42501/.test(err.code || ''));
    formulaireAvis.erreur = connu && err.message ? err.message : 'L\'envoi a échoué. Vérifiez votre connexion puis réessayez.';
    formulaireAvis.existant = { ...(formulaireAvis.existant || {}), avis: { ...((formulaireAvis.existant || {}).avis || {}), note, titre, texte } };
    rendreFormulaireAvis();
  }
}

// -----------------------------------------------------------------------------
//  MODERATION (console plateforme)
// -----------------------------------------------------------------------------

async function chargerModerationAvis(filtre = moderationAvis.filtre) {
  const liste = document.getElementById('saas-avis-liste');
  if (!liste || !supabaseClient) return;
  moderationAvis.filtre = filtre;
  document.querySelectorAll('[data-avis-filtre]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.avisFiltre === filtre)));
  liste.innerHTML = '<p class="text-xs text-slate-500 font-mono">Chargement…</p>';
  try {
    const { data, error } = await supabaseClient.rpc('reviews_moderation_list', { p_statut: filtre });
    if (error) throw error;
    moderationAvis.donnees = data;
  } catch (err) {
    liste.innerHTML = `<p class="text-xs text-red-300">Lecture impossible : ${echapAvis(err && err.message)}</p>`;
    return;
  }
  const compteur = document.getElementById('saas-avis-compteur');
  if (compteur) compteur.textContent = String((moderationAvis.donnees.compteurs || {}).PENDING ?? 0);

  const avis = moderationAvis.donnees.avis || [];
  if (!avis.length) {
    liste.innerHTML = '<p class="text-xs text-slate-500">Aucun avis dans cette catégorie.</p>';
    return;
  }
  liste.innerHTML = avis.map((a) => `
    <article class="avis-moderation">
      <div class="avis-moderation__tete">
        ${etoiles(a.note)}
        <strong>${echapAvis(a.auteur)}</strong>
        <span>${echapAvis(a.email || '')}</span>
        ${a.entreprise ? `<span>${echapAvis(a.entreprise)}${a.afficher_entreprise ? ' (affichée)' : ''}</span>` : ''}
        ${a.client_verifie ? '<span class="avis-badge">Client Timora</span>' : '<span class="avis-moderation__neutre">Non client</span>'}
        <span>${echapAvis(dateAvis(a.date))}</span>
      </div>
      ${a.titre ? `<p class="avis-moderation__titre">${echapAvis(a.titre)}</p>` : ''}
      <p class="avis-moderation__texte">${echapAvis(a.texte)}</p>
      <div class="avis-moderation__actions">
        ${a.statut !== 'APPROVED' ? `<button type="button" data-avis-moderer="${echapAvis(a.id)}" data-decision="APPROVED" class="avis-moderation__publier">Publier</button>` : ''}
        ${a.statut !== 'REJECTED' ? `<button type="button" data-avis-moderer="${echapAvis(a.id)}" data-decision="REJECTED" class="avis-moderation__refuser">Refuser</button>` : ''}
      </div>
    </article>`).join('');
}

async function modererAvis(id, decision) {
  if (moderationAvis.enCours) return;
  moderationAvis.enCours = true;
  try {
    const { error } = await supabaseClient.rpc('moderate_review', { p_id: id, p_decision: decision });
    if (error) throw error;
    if (typeof showToast === 'function') {
      showToast(decision === 'APPROVED' ? 'Avis publié' : 'Avis refusé',
        decision === 'APPROVED' ? 'Il apparaît maintenant sur la page d\'accueil.' : 'Il ne sera pas affiché.', 'success', 4000);
    }
  } catch (err) {
    if (typeof showToast === 'function') showToast('Action impossible', echapAvis(err && err.message), 'info', 6000);
  } finally {
    moderationAvis.enCours = false;
  }
  await chargerModerationAvis();
  chargerAvis();
}

// -----------------------------------------------------------------------------
//  EVENEMENTS
// -----------------------------------------------------------------------------

function initialiserAvis() {
  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-avis-action]');
    if (action) {
      const quoi = action.dataset.avisAction;
      if (quoi === 'donner') donnerMonAvis();
      else if (quoi === 'fermer') fermerFormulaireAvis();
      else if (quoi === 'recharger') chargerAvis();
      return;
    }
    const filtre = e.target.closest('[data-avis-filtre]');
    if (filtre) {
      chargerModerationAvis(filtre.dataset.avisFiltre);
      return;
    }
    const moderer = e.target.closest('[data-avis-moderer]');
    if (moderer) modererAvis(moderer.dataset.avisModerer, moderer.dataset.decision);
  });

  document.addEventListener('submit', (e) => {
    const formulaire = e.target.closest('[data-avis-form]');
    if (!formulaire) return;
    e.preventDefault();
    envoyerAvis(formulaire);
  });

  document.addEventListener('input', (e) => {
    if (e.target.id !== 'avis-texte-champ') return;
    const compteur = document.querySelector('[data-avis-compteur]');
    if (compteur) compteur.textContent = `${e.target.value.length} / 1000`;
  });

  document.addEventListener('keydown', (e) => {
    const m = modaleAvis();
    if (e.key === 'Escape' && m && !m.hidden) fermerFormulaireAvis();
  });

  // Les avis ne sont charges qu'a l'approche de la section : aucun appel pour
  // un visiteur qui ne descend pas jusque-la.
  const section = document.getElementById('avis');
  if (!section) return;
  if ('IntersectionObserver' in window) {
    const observateur = new IntersectionObserver((entrees) => {
      if (entrees.some((x) => x.isIntersecting)) {
        observateur.disconnect();
        chargerAvis();
      }
    }, { rootMargin: '600px 0px' });
    observateur.observe(section);
  } else {
    chargerAvis();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialiserAvis);
} else {
  initialiserAvis();
}
