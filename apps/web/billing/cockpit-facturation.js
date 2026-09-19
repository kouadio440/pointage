/* =============================================================================
 *  TIMORA — FACTURATION DANS LE COCKPIT (onglet « Facturation »)
 * =============================================================================
 *
 *  Abonnement en cours, usage par rapport aux limites de la formule,
 *  historique des paiements de L'entreprise, recus PDF.
 *
 *   - Donnees : billing_history (base), reserve au proprietaire et aux
 *     administrateurs de l'entreprise ; une autre entreprise n'est jamais
 *     visible, meme en modifiant la requete.
 *   - Recus : bucket PRIVE ; lien signe valable 60 secondes, delivre par
 *     Supabase apres controle des droits (politique de la migration 033).
 *   - Limites : la base refuse un collaborateur, un site ou un administrateur
 *     de trop (PLAN_*_LIMIT_REACHED). Ce module affiche le message et propose
 *     « Changer de formule » ; l'abonnement ne change qu'apres paiement.
 * ========================================================================== */

const facturationCockpit = { donnees: null, chargement: false };

const CODES_LIMITE_FORMULE = new Set(['PLAN_EMPLOYEE_LIMIT_REACHED', 'PLAN_SITE_LIMIT_REACHED', 'PLAN_ADMIN_LIMIT_REACHED']);
const echapFacturation = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
const fcfa = (n) => (typeof formaterFcfa === 'function' ? formaterFcfa(n) : `${n} FCFA`);

const LIBELLES_ETAT = {
  ACTIVE: ['Actif', 'is-ok'],
  PENDING_PAYMENT: ['En attente de paiement', 'is-attente'],
  EXPIRED: ['Expiré', 'is-alerte'],
  PAST_DUE: ['Paiement en retard', 'is-alerte'],
  CANCELLED: ['Résilié', 'is-alerte'],
  SUSPENDED: ['Suspendu', 'is-alerte'],
};
const LIBELLES_PAIEMENT = {
  COMPLETED: 'Payé',
  PENDING: 'En attente',
  PROCESSING: 'En vérification',
  FAILED: 'Échoué',
};

function dateCourteFacturation(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Africa/Abidjan' });
  } catch (err) {
    return '—';
  }
}

async function chargerFacturation() {
  const zone = document.getElementById('facturation-contenu');
  if (!zone || facturationCockpit.chargement) return;
  if (typeof supabaseClient === 'undefined' || !supabaseClient) {
    zone.innerHTML = '<p class="facturation-vide">La facturation est indisponible hors connexion.</p>';
    return;
  }
  facturationCockpit.chargement = true;
  zone.innerHTML = '<div class="facturation-chargement" role="status"><span class="auth-roue auth-roue--petite" aria-hidden="true"></span>Chargement de la facturation…</div>';
  try {
    const { data, error } = await supabaseClient.rpc('billing_history', {
      p_company: (typeof state !== 'undefined' && state.currentCompanyId) || null,
    });
    if (error) throw error;
    facturationCockpit.donnees = data;
    zone.innerHTML = rendreFacturation(data);
  } catch (err) {
    const reserve = err && (err.hint === 'DROITS_INSUFFISANTS' || err.code === '42501');
    zone.innerHTML = `<p class="facturation-vide">${reserve
      ? 'La facturation est réservée au propriétaire et aux administrateurs de l\'entreprise.'
      : 'La facturation n\'a pas pu être chargée. Vérifiez votre connexion puis réessayez.'}</p>`;
  } finally {
    facturationCockpit.chargement = false;
    if (window.lucide) window.lucide.createIcons();
  }
}

function jaugeFacturation(libelle, utilise, max) {
  const illimite = max === null || max === undefined;
  const pourcent = illimite ? 0 : Math.min(100, Math.round((utilise / Math.max(max, 1)) * 100));
  const plein = !illimite && utilise >= max;
  return `
    <div class="facturation-jauge${plein ? ' is-pleine' : ''}">
      <div class="facturation-jauge__ligne">
        <span>${echapFacturation(libelle)}</span>
        <strong>${utilise}${illimite ? '' : ` / ${max}`}</strong>
      </div>
      ${illimite ? '<small>Selon votre contrat</small>' : `<div class="facturation-jauge__barre"><span style="width:${pourcent}%"></span></div>`}
    </div>`;
}

function rendreFacturation(d) {
  const abo = d.abonnement || {};
  const lim = d.limites || {};
  const usage = d.usage || {};
  const [libelleEtat, classeEtat] = LIBELLES_ETAT[abo.etat] || ['Inconnu', 'is-attente'];
  const formule = (typeof PLANS_TIMORA !== 'undefined' && PLANS_TIMORA.find((p) => p.code === abo.plan)) || null;
  const finProche = abo.fin && (new Date(abo.fin).getTime() - Date.now()) < 7 * 86400000;

  const cellule = (libelle, contenu) => `<td data-label="${libelle}"><span class="facturation-cellule">${contenu}</span></td>`;
  const paiements = (d.paiements || []).map((p) => `
    <tr>
      ${cellule('Date', echapFacturation(dateCourteFacturation(p.date)))}
      ${cellule('Formule', `${echapFacturation(p.plan_name)} <small>${p.period === 'ANNUAL' ? '12 mois' : '1 mois'}</small>`)}
      ${cellule('Montant', `${echapFacturation(fcfa(p.amount))}${p.is_smoke_test
        ? `<small class="facturation-test">Test de production contrôlé — tarif normal ${echapFacturation(fcfa(p.normal_amount))}</small>` : ''}`)}
      ${cellule('Statut', `<span class="facturation-statut is-${echapFacturation(String(p.status).toLowerCase())}">${echapFacturation(LIBELLES_PAIEMENT[p.status] || p.status)}</span>`)}
      ${cellule('Reçu', p.receipt_path
        ? `<button type="button" class="facturation-recu" data-facturation-recu="${echapFacturation(p.receipt_path)}" data-facturation-numero="${echapFacturation(p.receipt_number)}">
             <i data-lucide="download" class="w-3.5 h-3.5" aria-hidden="true"></i>${echapFacturation(p.receipt_number)}</button>`
        : p.receipt_number ? `<small>${echapFacturation(p.receipt_number)} (en préparation)</small>` : '—')}
    </tr>`).join('');

  return `
    <div class="facturation-grille">
      <section class="facturation-carte" aria-labelledby="facturation-abonnement-titre">
        <h4 id="facturation-abonnement-titre">Abonnement</h4>
        <p class="facturation-formule">${echapFacturation(formule ? formule.nom : (lim.plan_name || 'Aucune formule'))}
          <span class="facturation-etat ${classeEtat}">${echapFacturation(libelleEtat)}</span></p>
        ${abo.fin ? `<p class="facturation-note">${abo.etat === 'ACTIVE' ? 'Actif jusqu\'au' : 'Échéance :'} ${echapFacturation(dateCourteFacturation(abo.fin))}</p>` : ''}
        <div class="facturation-actions">
          <button type="button" class="auth-bouton auth-bouton--principal" data-facturation-action="changer">
            <span>Changer de formule</span>
          </button>
          ${abo.etat !== 'ACTIVE' || finProche ? `
          <button type="button" class="auth-bouton auth-bouton--secondaire" data-facturation-action="renouveler">
            <span>Renouveler</span>
          </button>` : ''}
        </div>
      </section>

      <section class="facturation-carte" aria-labelledby="facturation-usage-titre">
        <h4 id="facturation-usage-titre">Utilisation de la formule</h4>
        ${jaugeFacturation('Collaborateurs actifs', usage.employees || 0, lim.max_employees)}
        ${jaugeFacturation('Sites de pointage actifs', usage.sites || 0, lim.max_sites)}
        ${jaugeFacturation('Administrateurs (propriétaire compris)', usage.admins || 0, lim.max_admins)}
        ${usage.pending ? `<p class="facturation-note">${usage.pending} demande(s) en attente (non comptées).</p>` : ''}
      </section>
    </div>

    <section class="facturation-carte" aria-labelledby="facturation-historique-titre">
      <h4 id="facturation-historique-titre">Historique des paiements</h4>
      ${paiements ? `
      <table class="facturation-table">
        <thead><tr><th>Date</th><th>Formule</th><th>Montant</th><th>Statut</th><th>Reçu</th></tr></thead>
        <tbody>${paiements}</tbody>
      </table>` : '<p class="facturation-vide">Aucun paiement pour le moment.</p>'}
    </section>`;
}

/** Recu PDF : lien signe de 60 secondes, delivre apres controle des droits. */
async function telechargerRecu(chemin, numero) {
  try {
    const { data, error } = await supabaseClient.storage.from('billing-receipts')
      .createSignedUrl(chemin, 60, { download: `${numero || 'recu-timora'}.pdf` });
    if (error || !data || !data.signedUrl) throw error || new Error('lien absent');
    window.open(data.signedUrl, '_blank', 'noopener');
  } catch (err) {
    if (typeof showToast === 'function') {
      showToast('Reçu indisponible', 'Le reçu n\'a pas pu être ouvert. Réessayez dans un instant.', 'warning', 8000);
    }
  }
}

function contexteFacturation() {
  const d = facturationCockpit.donnees || {};
  return {
    active: {
      company_id: (typeof state !== 'undefined' && state.currentCompanyId) || null,
      company_name: (typeof state !== 'undefined' && state.currentCompanyName) || null,
      role: 'owner',
    },
    billing: d.abonnement || {},
  };
}

async function ouvrirChangementFormule() {
  fermerLimiteFormule();
  if (!facturationCockpit.donnees && typeof supabaseClient !== 'undefined' && supabaseClient) {
    try {
      const { data } = await supabaseClient.rpc('billing_history', { p_company: state.currentCompanyId || null });
      facturationCockpit.donnees = data;
    } catch (err) {
      /* Sans l'etat courant, l'ecran de choix s'ouvre tout de meme. */
    }
  }
  if (typeof ouvrirActivation === 'function') ouvrirActivation(contexteFacturation(), { changement: true });
}

// -----------------------------------------------------------------------------
//  LIMITE DE FORMULE ATTEINTE
// -----------------------------------------------------------------------------

function fermerLimiteFormule() {
  const m = document.getElementById('modal-limite-formule');
  if (m) m.hidden = true;
}

function afficherLimiteFormule(message) {
  const m = document.getElementById('modal-limite-formule');
  if (!m) {
    if (typeof showToast === 'function') showToast('Limite de votre formule atteinte', echapFacturation(message), 'warning', 12000);
    return;
  }
  const texte = document.getElementById('limite-formule-message');
  if (texte) texte.textContent = message || 'Votre formule ne permet pas d\'en ajouter davantage.';
  m.hidden = false;
  if (window.lucide) window.lucide.createIcons();
  const titre = document.getElementById('limite-formule-titre');
  if (titre) titre.focus({ preventScroll: true });
}

/**
 * Erreur renvoyee par la base (RPC ou ecriture directe) : si c'est une limite
 * de formule, affiche le message et « Changer de formule ». true si traitee.
 */
function signalerLimiteFormule(err) {
  const hint = err && (err.hint || (err.details && err.details.hint));
  if (!hint || !CODES_LIMITE_FORMULE.has(hint)) return false;
  afficherLimiteFormule(err.message);
  return true;
}

function initialiserFacturationCockpit() {
  document.addEventListener('click', (e) => {
    const recu = e.target.closest('[data-facturation-recu]');
    if (recu) {
      telechargerRecu(recu.dataset.facturationRecu, recu.dataset.facturationNumero);
      return;
    }
    const action = e.target.closest('[data-facturation-action]');
    if (action) {
      if (action.dataset.facturationAction === 'changer') ouvrirChangementFormule();
      if (action.dataset.facturationAction === 'renouveler' && typeof ouvrirActivation === 'function') {
        ouvrirActivation(contexteFacturation(), { renouvellement: true });
      }
      return;
    }
    const limite = e.target.closest('[data-limite-action]');
    if (limite) {
      if (limite.dataset.limiteAction === 'changer') ouvrirChangementFormule();
      else fermerLimiteFormule();
    }
  });
  document.addEventListener('keydown', (e) => {
    const m = document.getElementById('modal-limite-formule');
    if (e.key === 'Escape' && m && !m.hidden) fermerLimiteFormule();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialiserFacturationCockpit);
else initialiserFacturationCockpit();
