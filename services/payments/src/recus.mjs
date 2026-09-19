// Recus : document PDF (stockage prive) puis e-mail, pour chaque paiement
// confirme. Le recu lui-meme (numero, montants, references) est emis par la
// base dans la transaction d'activation ; ici, on produit le fichier et on
// l'envoie. Tout est reprenable : un echec est retente par la tache periodique.

import { createHash } from 'node:crypto';
import { journaliser } from '../../../server/facturation/journal.mjs';
import { rpc, deposerFichier } from '../../../server/facturation/supabase.mjs';
import { genererRecuPdf } from './pdf-recu.mjs';
import { creerTransport, envoyerCourrielRecu } from './courriel.mjs';

export const BUCKET_RECUS = 'billing-receipts';

export function creerTraitementRecus(config, { deposer = deposerFichier, transport = undefined } = {}) {
  const enCours = new Set();
  const envoi = transport !== undefined ? transport : (config.courriel ? creerTransport(config.courriel) : null);
  let messagerieSignalee = false;

  async function traiter(recu) {
    if (!recu || !recu.id || enCours.has(recu.id)) return;
    enCours.add(recu.id);
    const trace = { receipt: recu.number, reference: recu.internal_reference };
    try {
      let pdf = null;
      if (!recu.storage_path) {
        pdf = await genererRecuPdf(recu, config.editeur);
        const chemin = `${recu.company_id}/${recu.number}.pdf`;
        const depot = await deposer(config, BUCKET_RECUS, chemin, pdf, 'application/pdf');
        if (!depot.ok) {
          journaliser('PAYMENT_RECEIPT_UPLOAD_FAILED', { ...trace, code: depot.code, http_status: depot.status ?? null });
          return;
        }
        const note = await rpc(config, 'billing_receipt_set_pdf', {
          p_receipt: recu.id, p_path: chemin, p_sha256: createHash('sha256').update(pdf).digest('hex'),
        });
        if (!note.ok) {
          journaliser('SUPABASE_WRITE_FAILED', { ...trace, etape: 'recu_pdf', code: note.erreur.code });
          return;
        }
        journaliser('PAYMENT_RECEIPT_STORED', { ...trace, octets: pdf.length });
      }

      if (!['PENDING', 'FAILED'].includes(recu.email_status)) return;
      if (!envoi) {
        // Sans messagerie configuree, l'e-mail attend (aucun essai compte).
        if (!messagerieSignalee) {
          journaliser('PAYMENT_EMAIL_PENDING', { raison: 'MESSAGERIE_NON_CONFIGUREE' });
          messagerieSignalee = true;
        }
        return;
      }
      if (!pdf) pdf = await genererRecuPdf(recu, config.editeur); // rendu deterministe : meme fichier
      const r = await envoyerCourrielRecu(envoi, config, recu, pdf);
      const note = await rpc(config, 'billing_receipt_set_email', {
        p_receipt: recu.id, p_ok: r.ok, p_error: r.ok ? null : r.code,
      });
      if (!note.ok) journaliser('SUPABASE_WRITE_FAILED', { ...trace, etape: 'recu_email', code: note.erreur.code });
      journaliser(r.ok ? 'PAYMENT_EMAIL_SENT' : 'PAYMENT_EMAIL_FAILED', {
        ...trace, code: r.ok ? null : r.code, premier: Boolean(recu.first_activation),
        statut: note.ok && note.data ? note.data.email_status : null,
      });
    } catch (err) {
      journaliser('PAYMENT_RECEIPT_FAILED', { ...trace, erreur: err && err.name });
    } finally {
      enCours.delete(recu.id);
    }
  }

  /** Recu tout juste emis (activation) : traite sans attendre la tache. */
  async function traiterUn(receiptId) {
    const r = await rpc(config, 'billing_receipt_json', { p_receipt: receiptId });
    if (r.ok && r.data) await traiter(r.data);
  }

  /** Recus sans document, e-mails en attente ou a retenter. */
  async function traiterEnAttente(limite = 10) {
    const r = await rpc(config, 'billing_receipts_a_traiter', { p_limit: limite });
    if (!r.ok) {
      journaliser('SUPABASE_WRITE_FAILED', { etape: 'recus_a_traiter', code: r.erreur.code });
      return 0;
    }
    const liste = Array.isArray(r.data) ? r.data : [];
    for (const recu of liste) await traiter(recu);
    return liste.length;
  }

  return { traiter, traiterUn, traiterEnAttente, messagerie: Boolean(envoi) };
}
