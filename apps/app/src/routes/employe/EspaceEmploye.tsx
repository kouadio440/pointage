import { APP_TIMEZONE } from '@pointage/design-tokens';
import { formatClock, formatDate } from '@pointage/shared';
import { useEffect, useState } from 'react';
import { Panel } from '../../ui/Panel.js';
import { StateBoundary } from '../../ui/StateBoundary.js';
import { StatusBadge } from '../../ui/Badge.js';

/**
 * Espace employe - « Mon temps de travail ».
 *
 * Mobile-first : c'est l'ecran le plus utilise du produit, majoritairement
 * depuis un telephone, souvent en reseau degrade.
 *
 * Squelette de phase 0 : la structure, le fuseau officiel et les etats
 * obligatoires sont en place. Le pointage reel (GPS, selfie, moteur anti-fraude)
 * arrive en phase 3, une fois l'authentification et le cloisonnement poses.
 */
export default function EspaceEmploye() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Horloge officielle Africa/Abidjan, comme la barre du site vitrine.
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">
          {formatDate(now, APP_TIMEZONE)}
        </p>
        <h1 className="text-2xl font-extrabold text-offwhite">Mon temps de travail</h1>
        <p className="tabular text-xs text-gold">{formatClock(now, APP_TIMEZONE)}</p>
      </header>

      <Panel accent="green" className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted">Statut du jour</p>
            <p className="mt-1 text-lg font-bold text-offwhite">Pas encore pointe</p>
          </div>
          <StatusBadge status="NOT_STARTED" label="NON POINTE" />
        </div>
      </Panel>

      <section className="space-y-3">
        <h2 className="text-sm font-bold text-offwhite">Mes derniers pointages</h2>

        <StateBoundary
          isLoading={false}
          isError={false}
          data={[]}
          skeleton={<Panel className="h-40 animate-pulse" />}
          empty={{
            title: "Aucun pointage enregistre aujourd'hui",
            body: "Vos arrivees et departs apparaitront ici des votre premier pointage de la journee, avec l'heure officielle et le site concerne.",
          }}
        >
          {(rows) => <div>{rows.length}</div>}
        </StateBoundary>
      </section>
    </div>
  );
}
