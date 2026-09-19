// Taches periodiques du serveur de paiement.
//
//   - recus        : documents et e-mails en attente ou a retenter (1 min) ;
//   - rapprochement: paiements en attente relus chez JoonaPay — webhook perdu,
//                    client parti avant le retour (5 min) ;
//   - expiration   : abonnements arrives a echeance passes EXPIRED (15 min).
//
// Jamais deux executions de la meme tache en parallele. Minuteries detachees
// (unref) : elles ne retiennent pas l'arret du processus.

import { journaliser } from '../../../server/facturation/journal.mjs';
import { rpc } from '../../../server/facturation/supabase.mjs';
import { synchroniser } from '../../../server/facturation/facturation.mjs';

export function creerTaches(config, recus) {
  const enCours = new Set();

  const executer = (nom, fn) => async () => {
    if (enCours.has(nom)) return;
    enCours.add(nom);
    try {
      await fn();
    } catch (err) {
      journaliser('TACHE_ECHEC', { tache: nom, erreur: err && err.name });
    } finally {
      enCours.delete(nom);
    }
  };

  const taches = {
    recus: executer('recus', () => recus.traiterEnAttente(10)),

    rapprochement: executer('rapprochement', async () => {
      const r = await rpc(config, 'billing_payments_a_reconcilier', { p_limit: 20 });
      if (!r.ok) {
        journaliser('SUPABASE_WRITE_FAILED', { etape: 'rapprochement', code: r.erreur.code });
        return;
      }
      for (const uuid of Array.isArray(r.data) ? r.data : []) {
        if (typeof uuid === 'string') await synchroniser(config, uuid, 'rapprochement');
      }
    }),

    expiration: executer('expiration', async () => {
      const r = await rpc(config, 'billing_expire_due', {});
      if (!r.ok) {
        journaliser('SUPABASE_WRITE_FAILED', { etape: 'expiration', code: r.erreur.code });
        return;
      }
      if (r.data && r.data.expires > 0) journaliser('SUBSCRIPTION_EXPIRED', { nombre: r.data.expires });
    }),
  };

  let minuteries = [];
  return {
    taches,
    demarrer() {
      const planifier = (fn, periodeMs, premierMs) => {
        const t1 = setTimeout(fn, premierMs);
        const t2 = setInterval(fn, periodeMs);
        t1.unref();
        t2.unref();
        minuteries.push(t1, t2);
      };
      planifier(taches.recus, 60 * 1000, 10 * 1000);
      planifier(taches.rapprochement, 5 * 60 * 1000, 30 * 1000);
      planifier(taches.expiration, 15 * 60 * 1000, 60 * 1000);
    },
    arreter() {
      minuteries.forEach((t) => clearTimeout(t));
      minuteries = [];
    },
  };
}
