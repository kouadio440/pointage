// Tests unitaires du serveur de paiement (sans reseau ni base) : npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { signer, verifier, RegistreNonces } from '../../../server/passerelle/signature.mjs';
import { lireConfigServeurPaiement } from '../../../server/facturation/config.mjs';
import { testProductionAutorise } from '../../../server/facturation/facturation.mjs';
import { Limiteur } from '../src/limiteur.mjs';
import { genererRecuPdf, montant } from '../src/pdf-recu.mjs';
import { composerCourriel } from '../src/courriel.mjs';

const SECRET = 's'.repeat(48);
const JETON = 'aaa.bbb.ccc';

function requete({ corps = '{"plan":"essentiel"}', maintenant = Date.now(), secret = SECRET, jeton = JETON } = {}) {
  return { entetes: Object.fromEntries(Object.entries(signer({ secret, methode: 'POST', chemin: '/api/payments/checkout', corps, jeton, maintenant })).map(([k, v]) => [k.toLowerCase(), v])), corps };
}

test('signature interne : valide une fois, puis nonce refuse', () => {
  const registre = new RegistreNonces();
  const { entetes, corps } = requete();
  const a = verifier({ secret: SECRET, methode: 'POST', chemin: '/api/payments/checkout', entetes, corps, registre });
  const b = verifier({ secret: SECRET, methode: 'POST', chemin: '/api/payments/checkout', entetes, corps, registre });
  assert.deepEqual([a.ok, a.jeton, b.ok, b.code], [true, JETON, false, 'NONCE_DEJA_UTILISE']);
});

test('signature interne : secret, chemin, corps, methode, jeton et horodatage verifies', () => {
  const cas = [
    [requete({ secret: 'x'.repeat(48) }), {}, 'SIGNATURE_INVALIDE'],
    [requete(), { chemin: '/api/payments/autre' }, 'SIGNATURE_INVALIDE'],
    [requete(), { corps: '{"plan":"pro"}' }, 'SIGNATURE_INVALIDE'],
    [requete(), { methode: 'GET' }, 'SIGNATURE_INVALIDE'],
    [requete(), { jeton: 'zzz.yyy.xxx' }, 'SIGNATURE_INVALIDE'],
    [requete({ maintenant: Date.now() - 301000 }), {}, 'HORODATAGE_HORS_DELAI'],
    [requete({ maintenant: Date.now() + 301000 }), {}, 'HORODATAGE_HORS_DELAI'],
  ];
  for (const [r, change, code] of cas) {
    const entetes = { ...r.entetes };
    if (change.jeton) entetes['x-timora-user-token'] = change.jeton;
    const v = verifier({
      secret: SECRET, methode: change.methode || 'POST', chemin: change.chemin || '/api/payments/checkout',
      entetes, corps: change.corps ?? r.corps, registre: new RegistreNonces(),
    });
    assert.equal(v.code, code, JSON.stringify(change));
  }
});

test('signature interne : requete signee avant le demarrage du serveur refusee', () => {
  const { entetes, corps } = requete({ maintenant: Date.now() - 60000 });
  const v = verifier({ secret: SECRET, methode: 'POST', chemin: '/api/payments/checkout', entetes, corps, registre: new RegistreNonces(), demarrageS: Math.floor(Date.now() / 1000) });
  assert.equal(v.code, 'HORODATAGE_HORS_DELAI');
});

test('signature interne : en-tetes absents ou mal formes', () => {
  const v = verifier({ secret: SECRET, methode: 'POST', chemin: '/x', entetes: {}, corps: '', registre: new RegistreNonces() });
  assert.equal(v.code, 'SIGNATURE_ABSENTE');
  assert.throws(() => signer({ secret: 'court', methode: 'POST', chemin: '/x' }));
});

test('limiteur : capacite puis refus, jetons rendus avec le temps', () => {
  const l = new Limiteur({ capacite: 2, parMinute: 60 });
  const t = 1000000;
  assert.deepEqual([l.autoriser('a', t), l.autoriser('a', t), l.autoriser('a', t)], [true, true, false]);
  assert.equal(l.autoriser('b', t), true);
  assert.equal(l.autoriser('a', t + 1000), true);
});

const ENV = {
  JOONAPAY_ENV: 'production',
  JOONAPAY_BASE_URL: 'https://apis.joonapay.com/api/v1/developer',
  JOONAPAY_CLIENT_KEY: 'c',
  JOONAPAY_PRIVATE_KEY: 'p',
  JOONAPAY_WEBHOOK_SECRET: 'w',
  JOONAPAY_WEBHOOK_URL: 'https://payments.timora.tech/api/webhooks/joonapay',
  SUPABASE_URL: 'https://projet.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  INTERNAL_PAYMENT_API_SECRET: SECRET,
  TIMORA_APP_URL: 'https://www.timora.tech',
};

test('configuration de production valide ; secrets absents des erreurs', () => {
  const c = lireConfigServeurPaiement(ENV);
  assert.equal(c.ok, true, JSON.stringify(c.erreurs));
  assert.equal(c.ecoute.hote, '127.0.0.1');
  const vide = lireConfigServeurPaiement({});
  assert.equal(vide.ok, false);
  assert.ok(vide.manquantes.includes('INTERNAL_PAYMENT_API_SECRET') && vide.manquantes.includes('TIMORA_APP_URL'));
});

test('configuration : production seulement vers apis.joonapay.com, secret interne >= 32 caracteres', () => {
  assert.equal(lireConfigServeurPaiement({ ...ENV, JOONAPAY_BASE_URL: 'https://api-counter-demo.wejoona.com/api/v1/developer' }).ok, false);
  assert.equal(lireConfigServeurPaiement({ ...ENV, JOONAPAY_BASE_URL: 'http://127.0.0.1:9000' }).ok, false);
  assert.equal(lireConfigServeurPaiement({ ...ENV, INTERNAL_PAYMENT_API_SECRET: 'court' }).ok, false);
  assert.equal(lireConfigServeurPaiement({ ...ENV, JOONAPAY_WEBHOOK_URL: 'http://localhost/webhook' }).ok, false);
});

test('test de production : bornes et usage unique imposes par la configuration', () => {
  const actif = { ...ENV, PRODUCTION_SMOKE_TEST_ENABLED: 'true' };
  const c = lireConfigServeurPaiement(actif);
  assert.deepEqual([c.ok, c.testProduction.active, c.testProduction.montant], [true, true, 100]);
  assert.equal(lireConfigServeurPaiement({ ...actif, PRODUCTION_SMOKE_TEST_AMOUNT: '15000' }).ok, false);
  assert.equal(lireConfigServeurPaiement({ ...actif, PRODUCTION_SMOKE_TEST_AMOUNT: '50' }).ok, false);
  assert.equal(lireConfigServeurPaiement({ ...actif, PRODUCTION_SMOKE_TEST_MAX_USES: '2' }).ok, false);
  assert.equal(lireConfigServeurPaiement({ ...actif, PRODUCTION_SMOKE_TEST_ALLOWED_EMAIL_HASH: 'pas-un-hash' }).ok, false);
  assert.equal(lireConfigServeurPaiement({ ...ENV, PRODUCTION_SMOKE_TEST_ENABLED: 'false' }).testProduction.active, false);
});

test('test de production : empreinte du compte comparee, jamais l\'adresse', () => {
  const empreinte = createHash('sha256').update('premier@client.ci').digest('hex');
  const c = lireConfigServeurPaiement({ ...ENV, PRODUCTION_SMOKE_TEST_ENABLED: 'true', PRODUCTION_SMOKE_TEST_ALLOWED_EMAIL_HASH: empreinte });
  assert.equal(testProductionAutorise(c, { id: 'u', email: '  Premier@Client.ci ' }), true);
  assert.equal(testProductionAutorise(c, { id: 'u', email: 'autre@client.ci' }), false);
  assert.equal(testProductionAutorise({ ...c, environnement: 'sandbox' }, { id: 'u', email: 'premier@client.ci' }), false);
  assert.equal(testProductionAutorise({ ...c, testProduction: { ...c.testProduction, active: false } }, { id: 'u', email: 'premier@client.ci' }), false);
});

const RECU = {
  number: 'TIM-REC-2026-000001', issued_at: '2026-09-20T10:15:00Z', paid_at: '2026-09-20T10:14:30Z',
  company_name: 'Entreprise <b>Exemple</b>', customer_name: 'Awa Koné', customer_email: 'awa@exemple.ci',
  plan_name: 'Essentiel', billing_period: 'MONTHLY', period_start: '2026-09-20T10:14:30Z', period_end: '2026-10-20T10:14:30Z',
  amount: 100, normal_amount: 15000, currency: 'XOF', is_smoke_test: true, first_activation: true,
  internal_reference: 'TIMORA-SUB-20260920-1A2B3C4D', provider_reference: 'C5CSWK5QMSEH', payment_method: 'WAVE_CI',
};

test('recu PDF : valide et deterministe', async () => {
  const a = await genererRecuPdf(RECU, {});
  const b = await genererRecuPdf(RECU, {});
  assert.equal(a.subarray(0, 5).toString(), '%PDF-');
  assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'));
  assert.equal(montant(15000), '15 000');
});

test('e-mail de bienvenue (test de production) : textes demandes, HTML echappe', () => {
  const m = composerCourriel(RECU, { appUrl: 'https://www.timora.tech' });
  assert.equal(m.sujet, 'Bienvenue sur Timora — votre abonnement est actif');
  assert.match(m.texte, /^Bonjour Awa,/);
  assert.match(m.texte, /Félicitations, votre entreprise Entreprise <b>Exemple<\/b> est maintenant active sur Timora\./);
  assert.match(m.texte, /Votre abonnement : Essentiel/);
  assert.match(m.texte, /Paiement : 100 FCFA pour ce test de production contrôlé/);
  assert.match(m.texte, /Pour les futurs paiements : tarification normale applicable/);
  assert.ok(m.html.includes('Entreprise &lt;b&gt;Exemple&lt;/b&gt;') && !m.html.includes('<b>Exemple</b>'));
  assert.match(m.html, /Accéder à mon espace Timora/);
});

test('e-mail d\'un vrai paiement : vrai montant, aucune mention de test', () => {
  const m = composerCourriel({ ...RECU, is_smoke_test: false, amount: 35000, normal_amount: 35000, plan_name: 'Business', first_activation: false }, { appUrl: 'https://www.timora.tech' });
  assert.equal(m.sujet, 'Votre reçu de paiement Timora TIM-REC-2026-000001');
  assert.match(m.texte, /Paiement : 35 000 FCFA \(Business, 1 mois\)/);
  assert.doesNotMatch(m.texte + m.html, /test de production/);
});
