/**
 * Moteur de score anti-fraude - politique v1.
 *
 * Trois proprietes non negociables :
 *
 * 1. DETERMINISTE. Le meme jeu de signaux produit toujours la meme decision.
 *    Les signaux sont persistes ligne par ligne (table FraudSignal) : les
 *    rejouer doit reproduire exactement le verdict. C'est ce qui rend un refus
 *    defendable face a un employe qui le conteste, et c'est teste.
 *
 * 2. VERSIONNEE. Un pointage garde la version de politique qui l'a juge.
 *    Durcir les seuils demain ne doit pas reecrire l'histoire d'hier.
 *
 * 3. AUCUN SIGNAL CLIENT N'EST DE CONFIANCE. Tout ce qui vient de l'appareil
 *    est une DECLARATION. L'heure fait foi cote serveur, la distance est
 *    recalculee cote serveur, et un score facial calcule sur le telephone
 *    n'est qu'un indice secondaire.
 */

export const FRAUD_POLICY_VERSION = 'v1';

export const FRAUD_SIGNALS = [
  // --- Vetos : un seul suffit a refuser -----------------------------
  'OUTSIDE_FENCE',
  'FACE_MISMATCH',
  'LIVENESS_FAIL',
  'QR_EXPIRED',
  'QR_REPLAY',
  'QR_FORGED',
  'MOCK_LOCATION',
  'SUBSCRIPTION_INACTIVE',

  // --- Signaux ponderes ---------------------------------------------
  'GPS_IMPRECISE',
  'IMPOSSIBLE_TRAVEL',
  'CLOCK_SKEW',
  'UNKNOWN_DEVICE',
  'VPN_OR_DATACENTER_IP',
  'COUNTRY_MISMATCH',
  'OFFLINE_BACKDATED',
  'ROOTED_DEVICE',
  'EMULATOR',
  'BEACON_ABSENT',
] as const;

export type FraudSignalCode = (typeof FRAUD_SIGNALS)[number];

/** D'ou vient le signal - determine s'il est exploitable en PWA. */
export type SignalSource = 'SERVER' | 'WEB' | 'NATIVE';

export interface SignalSpec {
  /** Poids ajoute au score. `null` pour un veto (le score devient sans objet). */
  weight: number | null;
  veto: boolean;
  source: SignalSource;
  /** Libelle affichable, en francais. */
  label: string;
}

/**
 * Table des signaux.
 *
 * Les entrees NATIVE sont declarees des maintenant mais restent nulles en PWA :
 * un navigateur ne peut structurellement PAS detecter une fausse position, un
 * appareil roote ou une balise Bluetooth. La coque Capacitor (phase 8) les
 * remplira sans modifier ni l'API ni ce fichier.
 */
export const SIGNAL_SPECS: Record<FraudSignalCode, SignalSpec> = {
  OUTSIDE_FENCE: { weight: null, veto: true, source: 'SERVER', label: 'Hors de la zone autorisee' },
  FACE_MISMATCH: { weight: null, veto: true, source: 'SERVER', label: 'Visage non reconnu' },
  LIVENESS_FAIL: {
    weight: null,
    veto: true,
    source: 'SERVER',
    label: 'Presence reelle non confirmee',
  },
  QR_EXPIRED: { weight: null, veto: true, source: 'SERVER', label: 'QR code expire' },
  QR_REPLAY: { weight: null, veto: true, source: 'SERVER', label: 'QR code deja utilise' },
  QR_FORGED: { weight: null, veto: true, source: 'SERVER', label: 'QR code non authentique' },
  MOCK_LOCATION: { weight: null, veto: true, source: 'NATIVE', label: 'Position simulee' },
  SUBSCRIPTION_INACTIVE: {
    weight: null,
    veto: true,
    source: 'SERVER',
    label: 'Abonnement inactif',
  },

  GPS_IMPRECISE: { weight: 25, veto: false, source: 'WEB', label: 'Position imprecise' },
  IMPOSSIBLE_TRAVEL: { weight: 40, veto: false, source: 'SERVER', label: 'Deplacement impossible' },
  CLOCK_SKEW: { weight: 20, veto: false, source: 'SERVER', label: "Horloge de l'appareil decalee" },
  UNKNOWN_DEVICE: { weight: 15, veto: false, source: 'WEB', label: 'Appareil non reconnu' },
  VPN_OR_DATACENTER_IP: {
    weight: 20,
    veto: false,
    source: 'SERVER',
    label: 'Connexion via VPN ou datacenter',
  },
  COUNTRY_MISMATCH: { weight: 20, veto: false, source: 'SERVER', label: 'Pays incoherent' },
  OFFLINE_BACKDATED: {
    weight: 10,
    veto: false,
    source: 'SERVER',
    label: 'Pointage differe hors ligne',
  },
  ROOTED_DEVICE: { weight: 30, veto: false, source: 'NATIVE', label: 'Appareil roote ou debride' },
  EMULATOR: { weight: 30, veto: false, source: 'NATIVE', label: 'Emulateur detecte' },
  BEACON_ABSENT: { weight: 30, veto: false, source: 'NATIVE', label: 'Balise Bluetooth absente' },
};

export const DECISIONS = ['ACCEPTED', 'PENDING_REVIEW', 'REJECTED'] as const;
export type PunchDecision = (typeof DECISIONS)[number];

/** Seuils de decision. Un score >= REJECT refuse, >= REVIEW met en attente. */
export const SCORE_THRESHOLDS = { REVIEW: 30, REJECT: 60 } as const;

/** Un signal releve pour un pointage donne. */
export interface RaisedSignal {
  code: FraudSignalCode;
  /** Valeur mesuree, conservee pour l'audit ("412" m, "18" min...). */
  value?: string;
}

export interface FraudVerdict {
  decision: PunchDecision;
  score: number;
  policyVersion: string;
  /** Premier veto rencontre, dans l'ordre de FRAUD_SIGNALS. */
  vetoedBy: FraudSignalCode | null;
  /** Signaux ponderes ayant contribue au score. */
  contributors: { code: FraudSignalCode; weight: number }[];
}

/**
 * Rend le verdict a partir des signaux releves.
 *
 * Fonction PURE : aucune I/O, aucune horloge, aucun aleatoire. C'est ce qui
 * permet de la rejouer sur les lignes archivees et d'obtenir le meme resultat.
 */
export function evaluateFraud(signals: readonly RaisedSignal[]): FraudVerdict {
  // Les doublons ne doivent pas gonfler le score : un meme signal ne compte qu'une fois.
  const seen = new Set<FraudSignalCode>();
  const unique: FraudSignalCode[] = [];
  for (const s of signals) {
    if (!seen.has(s.code)) {
      seen.add(s.code);
      unique.push(s.code);
    }
  }

  // Veto : on retient le premier dans l'ordre canonique, pas dans l'ordre d'arrivee,
  // pour que le resultat ne depende pas de l'ordre d'insertion.
  const vetoedBy = FRAUD_SIGNALS.find((c) => seen.has(c) && SIGNAL_SPECS[c].veto) ?? null;

  const contributors = unique
    .filter((c) => !SIGNAL_SPECS[c].veto)
    .map((c) => ({ code: c, weight: SIGNAL_SPECS[c].weight ?? 0 }))
    .sort((a, b) => b.weight - a.weight || a.code.localeCompare(b.code));

  const score = contributors.reduce((sum, c) => sum + c.weight, 0);

  let decision: PunchDecision;
  if (vetoedBy !== null) {
    decision = 'REJECTED';
  } else if (score >= SCORE_THRESHOLDS.REJECT) {
    decision = 'REJECTED';
  } else if (score >= SCORE_THRESHOLDS.REVIEW) {
    decision = 'PENDING_REVIEW';
  } else {
    decision = 'ACCEPTED';
  }

  return { decision, score, policyVersion: FRAUD_POLICY_VERSION, vetoedBy, contributors };
}

/** Signaux qu'un navigateur ne peut pas produire - documentes pour la phase 8. */
export const NATIVE_ONLY_SIGNALS = FRAUD_SIGNALS.filter((c) => SIGNAL_SPECS[c].source === 'NATIVE');
