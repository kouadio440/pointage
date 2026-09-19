// POST /api/webhooks/joonapay  (www.timora.tech, Vercel) — ADRESSE HISTORIQUE
//
// Le webhook de production est declare chez JoonaPay a l'adresse du serveur
// de paiement : https://payments.timora.tech/api/webhooks/joonapay. Cette
// route ne sert qu'aux paiements crees avant ce changement : elle relaie le
// corps BRUT et la signature JoonaPay tels quels. Vercel ne verifie rien et
// ne decide de rien : le serveur de paiement verifie la signature, relit le
// paiement chez JoonaPay et applique son etat.

const TAILLE_MAX = 64 * 1024;

const reponse = (status, corps) => new Response(JSON.stringify(corps), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

export async function POST(request) {
  const cible = String(process.env.PAYMENT_SERVER_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(cible)) return reponse(503, { received: false });

  const corpsBrut = Buffer.from(await request.arrayBuffer());
  if (corpsBrut.length === 0 || corpsBrut.length > TAILLE_MAX) return reponse(400, { received: false });

  const signature = request.headers.get('x-webhook-signature');
  try {
    const r = await fetch(`${cible}/api/webhooks/joonapay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Webhook-Signature': signature } : {}) },
      body: corpsBrut,
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
    });
    const corps = await r.json().catch(() => ({}));
    return reponse(r.status, { received: Boolean(corps && corps.received) });
  } catch {
    // Serveur de paiement injoignable : JoonaPay renverra la notification.
    return reponse(503, { received: false });
  }
}
