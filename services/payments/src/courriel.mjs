// E-mail envoye apres un paiement confirme : bienvenue (premiere activation)
// ou recu (renouvellement, changement de formule), recu PDF en piece jointe.
//
// Un echec d'envoi ne touche NI au paiement NI a l'abonnement : il est note
// sur le recu (billing_receipt_set_email) et retente plus tard.

import nodemailer from 'nodemailer';
import { montant, moyenLisible } from './pdf-recu.mjs';

const echapper = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function creerTransport(courriel) {
  return nodemailer.createTransport({
    host: courriel.hote,
    port: courriel.port,
    secure: courriel.securise,
    auth: courriel.utilisateur ? { user: courriel.utilisateur, pass: courriel.motDePasse } : undefined,
    requireTLS: !courriel.securise,
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

function prenom(nom) {
  const p = String(nom || '').trim().split(/\s+/)[0];
  return p && p.length <= 40 ? p : '';
}

/** Sujet, texte et HTML de l'e-mail d'un recu. */
export function composerCourriel(recu, { appUrl }) {
  const bonjour = prenom(recu.customer_name) ? `Bonjour ${prenom(recu.customer_name)},` : 'Bonjour,';
  const periode = recu.billing_period === 'ANNUAL' ? 'an' : 'mois';
  const paiement = recu.is_smoke_test
    ? `${montant(recu.amount)} FCFA pour ce test de production contrôlé`
    : `${montant(recu.amount)} FCFA (${recu.plan_name}, 1 ${periode})`;
  const futur = recu.is_smoke_test
    ? `Pour les futurs paiements : tarification normale applicable (${recu.plan_name} : ${montant(recu.normal_amount)} FCFA par ${periode}).`
    : null;
  const lien = `${appUrl}/`;

  const sujet = recu.first_activation
    ? 'Bienvenue sur Timora — votre abonnement est actif'
    : `Votre reçu de paiement Timora ${recu.number}`;
  const introduction = recu.first_activation
    ? `Félicitations, votre entreprise ${recu.company_name} est maintenant active sur Timora.`
    : `Nous avons bien reçu votre paiement pour ${recu.company_name}. Votre abonnement Timora est actif.`;

  const lignes = [
    bonjour,
    '',
    introduction,
    '',
    `Votre abonnement : ${recu.plan_name}`,
    `Paiement : ${paiement}`,
    `Moyen de paiement : ${moyenLisible(recu.payment_method)}`,
    `Reçu : ${recu.number} (en pièce jointe)`,
    ...(futur ? ['', futur] : []),
    '',
    `Accéder à mon espace Timora : ${lien}`,
    '',
    'L\'équipe Timora',
  ];

  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td style="font-size:22px;font-weight:bold;color:#0f766e;padding-bottom:16px">Timora</td></tr>
<tr><td style="font-size:15px;line-height:1.6">
<p style="margin:0 0 12px">${echapper(bonjour)}</p>
<p style="margin:0 0 16px">${echapper(introduction)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;border-top:1px solid #e2e8f0">
<tr><td style="padding:8px 0;color:#475569">Votre abonnement</td><td style="padding:8px 0;text-align:right;font-weight:bold">${echapper(recu.plan_name)}</td></tr>
<tr><td style="padding:8px 0;color:#475569;border-top:1px solid #e2e8f0">Paiement</td><td style="padding:8px 0;text-align:right;border-top:1px solid #e2e8f0">${echapper(paiement)}</td></tr>
<tr><td style="padding:8px 0;color:#475569;border-top:1px solid #e2e8f0">Reçu</td><td style="padding:8px 0;text-align:right;border-top:1px solid #e2e8f0">${echapper(recu.number)} (en pièce jointe)</td></tr>
</table>
${futur ? `<p style="margin:16px 0 0;font-size:13px;color:#92400e;background:#fef3c7;border-radius:8px;padding:10px 12px">${echapper(futur)}</p>` : ''}
<p style="margin:24px 0"><a href="${echapper(lien)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">Accéder à mon espace Timora</a></p>
<p style="margin:0;color:#475569;font-size:13px">L'équipe Timora</p>
</td></tr></table></td></tr></table></body></html>`;

  return { sujet, texte: lignes.join('\n'), html };
}

/**
 * Envoie l'e-mail d'un recu. Renvoie { ok } ou { ok: false, code } ; ne leve
 * jamais d'exception et ne journalise aucun identifiant de messagerie.
 */
export async function envoyerCourrielRecu(transport, config, recu, pdf) {
  if (!recu.customer_email) return { ok: false, code: 'DESTINATAIRE_ABSENT' };
  const { sujet, texte, html } = composerCourriel(recu, { appUrl: config.appUrl });
  try {
    await transport.sendMail({
      from: config.courriel.expediteur,
      to: recu.customer_email,
      replyTo: config.courriel.repondreA || undefined,
      subject: sujet,
      text: texte,
      html,
      attachments: pdf ? [{ filename: `${recu.number}.pdf`, content: pdf, contentType: 'application/pdf' }] : [],
      headers: { 'X-Timora-Receipt': recu.number },
    });
    return { ok: true };
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'ENVOI_ECHOUE';
    const reponse = err && typeof err.responseCode === 'number' ? ` ${err.responseCode}` : '';
    return { ok: false, code: `${code}${reponse}`.slice(0, 60) };
  }
}
