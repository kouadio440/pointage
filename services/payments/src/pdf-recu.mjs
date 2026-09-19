// Recu de paiement Timora (PDF).
//
// « Reçu de paiement », pas « facture » : les mentions legales d'une facture
// ne sont pas toutes disponibles. Les mentions de l'editeur (nom, adresse,
// identifiants) ne figurent que si elles sont configurees : rien n'est invente.
// Un test de production est signale comme tel, avec le tarif normal a cote :
// le document ne peut pas faire croire que ce montant est un prix.
//
// Rendu deterministe (dates du document = date d'emission) : regenerer le
// meme recu donne le meme fichier.

import PDFDocument from 'pdfkit';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOGO = fileURLToPath(new URL('../../../apps/web/assets/marque/timora-logo-fond-clair.png', import.meta.url));
const logo = existsSync(LOGO) ? readFileSync(LOGO) : null;

const ENCRE = '#0f172a';
const GRIS = '#475569';
const TRAIT = '#cbd5e1';
const ACCENT = '#0f766e';
const ALERTE = '#b45309';

const MOYENS = {
  WAVE_CI: 'Wave (Côte d\'Ivoire)',
  WAVE_SN: 'Wave (Sénégal)',
  ORANGE_MONEY_CI: 'Orange Money (Côte d\'Ivoire)',
  ORANGE_CI: 'Orange Money (Côte d\'Ivoire)',
  MTN_CI: 'MTN Mobile Money (Côte d\'Ivoire)',
  MOOV_CI: 'Moov Money (Côte d\'Ivoire)',
  CARD: 'Carte bancaire',
};

/** 15000 -> « 15 000 » (espace simple : la police standard du PDF l'affiche partout). */
export function montant(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function dateLongue(iso) {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Abidjan', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(iso));
}

function dateCourte(iso) {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Abidjan', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(iso));
}

export function moyenLisible(code) {
  if (!code) return 'Paiement en ligne (JoonaPay)';
  return MOYENS[code] || `${code.replace(/_/g, ' ')} (JoonaPay)`;
}

/**
 * @param recu    billing_receipt_json (base)
 * @param editeur mentions configurees (TIMORA_LEGAL_*), facultatives
 * @returns Promise<Buffer>
 */
export function genererRecuPdf(recu, editeur = {}) {
  return new Promise((ok, echec) => {
    const emis = new Date(recu.issued_at || recu.paid_at || Date.now());
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `Reçu de paiement ${recu.number}`,
        Author: 'Timora',
        Subject: 'Reçu de paiement',
        Creator: 'Timora',
        Producer: 'Timora',
        CreationDate: emis,
        ModDate: emis,
      },
    });
    const morceaux = [];
    doc.on('data', (m) => morceaux.push(m));
    doc.on('end', () => ok(Buffer.concat(morceaux)));
    doc.on('error', echec);

    const gauche = 50;
    const largeur = doc.page.width - 100;

    // En-tete : logo, titre, numero, date.
    if (logo) doc.image(logo, gauche, 45, { width: 150 });
    else doc.font('Helvetica-Bold').fontSize(22).fillColor(ENCRE).text('TIMORA', gauche, 50);

    doc.font('Helvetica-Bold').fontSize(16).fillColor(ENCRE)
      .text('REÇU DE PAIEMENT', gauche, 50, { width: largeur, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(GRIS)
      .text(`N° ${recu.number}`, gauche, 72, { width: largeur, align: 'right' })
      .text(`Date : ${dateLongue(recu.issued_at)}`, { width: largeur, align: 'right' });

    doc.moveTo(gauche, 110).lineTo(gauche + largeur, 110).lineWidth(1).strokeColor(TRAIT).stroke();

    // Emetteur et client.
    let y = 125;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRIS).text('ÉMIS PAR', gauche, y);
    doc.text('CLIENT', gauche + largeur / 2, y);
    y += 14;
    const emetteur = [
      editeur.nom || 'Timora',
      editeur.adresse,
      editeur.identifiants,
      'www.timora.tech',
      editeur.contact,
    ].filter(Boolean).join('\n');
    const client = [recu.company_name, recu.customer_name, recu.customer_email].filter(Boolean).join('\n');
    doc.font('Helvetica').fontSize(10).fillColor(ENCRE)
      .text(emetteur, gauche, y, { width: largeur / 2 - 10 });
    const hauteurEmetteur = doc.y;
    doc.text(client || '-', gauche + largeur / 2, y, { width: largeur / 2 });
    y = Math.max(hauteurEmetteur, doc.y) + 20;

    // Test de production : signale sans ambiguite.
    if (recu.is_smoke_test) {
      doc.roundedRect(gauche, y, largeur, 46, 6).fillColor('#fef3c7').fill();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(ALERTE)
        .text('TEST DE PRODUCTION CONTRÔLÉ', gauche + 12, y + 9, { width: largeur - 24 });
      doc.font('Helvetica').fontSize(9).fillColor(ALERTE)
        .text(`Montant de test, à usage unique. Ce n'est pas le prix de la formule ${recu.plan_name} : son tarif normal est de ${montant(recu.normal_amount)} XOF par mois.`,
          gauche + 12, y + 23, { width: largeur - 24 });
      y += 62;
    }

    // Detail.
    const periode = recu.billing_period === 'ANNUAL' ? '12 mois' : '1 mois';
    const lignes = [
      ['Formule', `${recu.plan_name} (${periode})`],
      ['Période couverte', recu.period_start && recu.period_end
        ? `du ${dateCourte(recu.period_start)} au ${dateCourte(recu.period_end)}` : '-'],
      ['Tarif normal', `${montant(recu.normal_amount)} XOF / ${recu.billing_period === 'ANNUAL' ? 'an' : 'mois'}`],
      ['Montant payé', `${montant(recu.amount)} XOF`],
      ['Devise', 'XOF (franc CFA BCEAO)'],
      ['Statut', 'PAYÉ'],
      ['Date du paiement', dateLongue(recu.paid_at)],
      ['Moyen de paiement', moyenLisible(recu.payment_method)],
      ['Référence Timora', recu.internal_reference],
      ['Référence JoonaPay', recu.provider_reference || '-'],
    ];

    doc.font('Helvetica-Bold').fontSize(11).fillColor(ENCRE).text('Détail du paiement', gauche, y);
    y += 20;
    for (const [libelle, valeur] of lignes) {
      const important = libelle === 'Montant payé' || libelle === 'Statut';
      doc.font('Helvetica').fontSize(10).fillColor(GRIS).text(libelle, gauche, y, { width: 170 });
      doc.font(important ? 'Helvetica-Bold' : 'Helvetica').fontSize(10)
        .fillColor(libelle === 'Statut' ? ACCENT : ENCRE)
        .text(String(valeur), gauche + 180, y, { width: largeur - 180 });
      y = Math.max(y + 18, doc.y + 6);
      doc.moveTo(gauche, y - 5).lineTo(gauche + largeur, y - 5).lineWidth(0.5).strokeColor(TRAIT).stroke();
    }

    // Total.
    y += 10;
    doc.roundedRect(gauche + largeur / 2, y, largeur / 2, 40, 6).fillColor('#f1f5f9').fill();
    doc.font('Helvetica').fontSize(10).fillColor(GRIS).text('TOTAL PAYÉ', gauche + largeur / 2 + 14, y + 8);
    doc.font('Helvetica-Bold').fontSize(16).fillColor(ENCRE)
      .text(`${montant(recu.amount)} XOF`, gauche + largeur / 2 + 14, y + 8, { width: largeur / 2 - 28, align: 'right' });

    // Pied.
    doc.font('Helvetica').fontSize(8).fillColor(GRIS)
      .text('Ce document atteste d\'un paiement reçu par Timora pour l\'abonnement indiqué. Il ne constitue pas une facture.',
        gauche, doc.page.height - 90, { width: largeur, align: 'center' })
      .text(`Document émis automatiquement le ${dateLongue(recu.issued_at)} — ${recu.number}`, { width: largeur, align: 'center' });

    doc.end();
  });
}
