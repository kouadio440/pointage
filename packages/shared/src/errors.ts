/**
 * Catalogue d'erreurs - source unique, cote API comme cote interface.
 *
 * L'API renvoie un `code` ; l'interface affiche le texte correspondant. Les deux
 * lisent CE fichier, donc ils ne peuvent pas diverger. Un message de refus qui
 * ment ou reste vague est le pire defaut possible sur un produit de pointage :
 * l'employe doit comprendre pourquoi il est refuse et ce qu'il doit faire.
 *
 * Regle de redaction, appliquee a chaque entree :
 *   - `title`  : ce qui s'est passe, sans jargon ;
 *   - `body`   : la raison CHIFFREE (distance reelle, rayon autorise, delai) ;
 *   - `action` : ce que la personne doit faire maintenant.
 *
 * Le cahier des charges (l. 1544-1552) interdit explicitement les messages secs
 * du type "Aucun pointage" ou "Erreur".
 */

export interface ErrorEntry<P = void> {
  /** Statut HTTP renvoye par l'API pour ce code. */
  status: number;
  title: string;
  body: (params: P) => string;
  /** Consigne concrete. Absent seulement quand l'utilisateur ne peut rien faire. */
  action?: string;
}

export const ERROR_COPY = {
  // ---------------------------------------------------------------- Auth
  AUTH_INVALID_CREDENTIALS: {
    status: 401,
    title: 'Identifiants incorrects',
    // Volontairement identique que l'identifiant existe ou non : distinguer les
    // deux cas permettrait d'enumerer les comptes d'une entreprise.
    body: () => "L'identifiant ou le mot de passe ne correspond pas.",
    action: 'Verifiez votre saisie, puis reessayez.',
  },
  AUTH_ACCOUNT_LOCKED: {
    status: 423,
    title: 'Compte temporairement bloque',
    body: (p: { minutes: number }) =>
      `Trop de tentatives echouees. Le compte est bloque pendant ${p.minutes} minute(s).`,
    action: 'Patientez, ou contactez votre service RH pour un deblocage immediat.',
  },
  AUTH_ACCOUNT_NOT_ACTIVATED: {
    status: 403,
    title: 'Compte non active',
    body: () => "Ce compte existe mais n'a pas encore ete active.",
    action: "Ouvrez le lien d'activation recu par e-mail ou SMS.",
  },
  AUTH_ACCOUNT_SUSPENDED: {
    status: 403,
    title: 'Compte suspendu',
    body: () => "Votre acces a ete suspendu par l'administrateur de votre entreprise.",
    action: 'Contactez votre service RH.',
  },
  AUTH_COMPANY_CODE_UNKNOWN: {
    status: 401,
    title: 'Code entreprise inconnu',
    body: () => 'Aucune entreprise ne correspond a ce code.',
    action: 'Le code figure sur votre fiche de connexion (format WDS-4821).',
  },
  AUTH_TOKEN_EXPIRED: {
    status: 401,
    title: 'Session expiree',
    body: () => 'Votre session a expire pour des raisons de securite.',
    action: 'Reconnectez-vous.',
  },
  AUTH_REFRESH_REUSED: {
    status: 401,
    title: 'Session revoquee',
    body: () =>
      'Un jeton de session deja utilise a ete rejoue. Par precaution, toutes vos sessions ont ete fermees.',
    action: "Reconnectez-vous. Si vous n'etes pas a l'origine de cette action, prevenez votre RH.",
  },
  AUTH_OTP_INVALID: {
    status: 401,
    title: 'Code de verification invalide',
    body: (p: { attemptsLeft: number }) =>
      `Ce code ne correspond pas. Il vous reste ${p.attemptsLeft} tentative(s).`,
    action: 'Ressaisissez le code recu par SMS, ou demandez-en un nouveau.',
  },
  AUTH_OTP_EXPIRED: {
    status: 410,
    title: 'Code de verification expire',
    body: (p: { validMinutes: number }) => `Ce code n'est valable que ${p.validMinutes} minutes.`,
    action: 'Demandez un nouveau code.',
  },

  // ---------------------------------------------------------------- RBAC
  RBAC_MISSING_PERMISSION: {
    status: 403,
    title: 'Action non autorisee',
    body: (p: { permission: string }) =>
      `Votre role ne dispose pas de l'autorisation requise (${p.permission}).`,
    action: "Demandez a votre RH ou a la direction d'ajuster vos droits.",
  },
  RBAC_OUT_OF_SCOPE: {
    // 404 et non 403 : un 403 confirmerait que la ressource existe.
    status: 404,
    title: 'Introuvable',
    body: () => "Cette ressource n'existe pas, ou ne fait pas partie de votre perimetre.",
  },

  // ------------------------------------------------------------ Pointage
  PUNCH_OUTSIDE_FENCE: {
    status: 422,
    title: 'Pointage refuse - hors de la zone autorisee',
    body: (p: { distanceM: number; siteName: string; radiusM: number }) =>
      `Vous etes a ${p.distanceM} m de ${p.siteName}. La zone autorisee est de ${p.radiusM} m.`,
    action: 'Rapprochez-vous du site, puis reessayez.',
  },
  PUNCH_GPS_IMPRECISE: {
    status: 422,
    title: 'Position trop imprecise',
    body: (p: { accuracyM: number; maxAccuracyM: number }) =>
      `La precision de votre position est de ${p.accuracyM} m, au-dela du maximum autorise de ${p.maxAccuracyM} m.`,
    action:
      "Sortez a l'exterieur ou approchez-vous d'une fenetre, attendez quelques secondes, puis reessayez.",
  },
  PUNCH_GPS_DENIED: {
    status: 422,
    title: 'Localisation desactivee',
    body: () => 'Le pointage exige votre position : elle prouve que vous etes bien sur le site.',
    action:
      'Autorisez la localisation dans les reglages de votre navigateur, puis rechargez la page.',
  },
  PUNCH_CAMERA_DENIED: {
    status: 422,
    title: 'Camera indisponible',
    body: () => "La verification faciale exige l'acces a la camera.",
    action: "Autorisez la camera, ou pointez par QR code au poste d'entree.",
  },
  PUNCH_FACE_MISMATCH: {
    status: 422,
    title: 'Visage non reconnu',
    body: (p: { score: number; threshold: number }) =>
      `La correspondance avec votre photo de reference est de ${p.score} %, en dessous du seuil requis de ${p.threshold} %.`,
    action:
      'Retirez lunettes de soleil, casquette ou masque, placez-vous face a la lumiere et recommencez.',
  },
  PUNCH_LIVENESS_FAIL: {
    status: 422,
    title: 'Verification faciale non concluante',
    body: () => "Le systeme n'a pas detecte de presence reelle devant la camera.",
    action: 'Regardez droit vers la camera, dans un endroit bien eclaire, puis recommencez.',
  },
  PUNCH_MOCK_LOCATION: {
    status: 422,
    title: 'Position simulee detectee',
    body: () =>
      'Votre appareil signale une position fournie par une application de simulation GPS.',
    action:
      "Desactivez toute application de fausse position, puis reessayez. L'incident a ete signale.",
  },
  PUNCH_DEVICE_UNTRUSTED: {
    status: 422,
    title: 'Appareil non reconnu',
    body: (p: { deviceLabel: string }) =>
      `Ce pointage provient d'un appareil inconnu (${p.deviceLabel}).`,
    action: "Utilisez votre appareil habituel, ou demandez a votre RH d'enregistrer celui-ci.",
  },
  PUNCH_QR_EXPIRED: {
    status: 422,
    title: 'QR code expire',
    body: (p: { rotationSeconds: number }) =>
      `Ce QR code change toutes les ${p.rotationSeconds} secondes et n'est plus valable.`,
    action: "Scannez a nouveau le code affiche a l'ecran du poste.",
  },
  PUNCH_QR_REPLAY: {
    status: 422,
    title: 'QR code deja utilise',
    body: () => 'Ce code a deja servi a un pointage.',
    action: "Scannez le code actuellement affiche. Une photo d'ecran ne fonctionne pas.",
  },
  PUNCH_QR_FORGED: {
    status: 422,
    title: 'QR code invalide',
    body: () => "Ce code ne provient pas d'un poste de pointage de votre entreprise.",
    action: "Scannez le code affiche sur le poste officiel. L'incident a ete signale.",
  },
  PUNCH_DUPLICATE: {
    status: 409,
    title: 'Pointage deja enregistre',
    body: (p: { at: string; type: string }) =>
      `Un pointage de type ${p.type} a deja ete enregistre a ${p.at}.`,
    action: 'Aucune action necessaire : votre presence est bien prise en compte.',
  },
  PUNCH_OUT_WITHOUT_IN: {
    status: 409,
    title: "Aucune arrivee enregistree aujourd'hui",
    body: () => "Impossible d'enregistrer un depart sans arrivee prealable.",
    action: 'Signalez-le a votre RH : une arrivee doit etre ajoutee manuellement.',
  },
  PUNCH_TOO_SOON: {
    status: 409,
    title: 'Pointage trop rapproche',
    body: (p: { waitSeconds: number }) =>
      `Un pointage vient d'etre enregistre. Patientez ${p.waitSeconds} seconde(s).`,
    action: 'Reessayez dans un instant.',
  },
  PUNCH_CLOCK_SKEW: {
    status: 422,
    title: "L'heure de votre appareil est incorrecte",
    body: (p: { driftMinutes: number }) =>
      `L'horloge de votre appareil avance ou retarde de ${p.driftMinutes} minutes par rapport a l'heure officielle.`,
    action: "Activez la mise a l'heure automatique dans les reglages, puis reessayez.",
  },
  PUNCH_IMPOSSIBLE_TRAVEL: {
    status: 422,
    title: 'Deplacement impossible detecte',
    body: (p: { distanceKm: number; minutes: number }) =>
      `Votre pointage precedent a eu lieu a ${p.distanceKm} km d'ici, il y a ${p.minutes} minutes.`,
    action:
      'Votre pointage est enregistre mais soumis a verification. Votre responsable a ete prevenu.',
  },
  PUNCH_PENDING_REVIEW: {
    status: 202,
    title: 'Pointage enregistre - verification en cours',
    body: () =>
      'Votre pointage a bien ete enregistre, mais un controle de securite est requis avant validation.',
    action: 'Aucune action de votre part. Votre responsable a ete notifie.',
  },
  PUNCH_MANUAL_FORBIDDEN: {
    status: 403,
    title: 'Pointage manuel reserve au service RH',
    body: () => "Seul le service RH peut saisir un pointage a la place d'un employe.",
    action: 'Adressez votre demande de correction a votre RH.',
  },

  // -------------------------------------------------------- Abonnement
  SUBSCRIPTION_SUSPENDED: {
    status: 402,
    title: 'Abonnement suspendu',
    body: (p: { since: string }) =>
      `L'abonnement de votre entreprise est suspendu depuis le ${p.since}. Le pointage est interrompu.`,
    action: 'Contactez votre direction pour regulariser le paiement.',
  },
  SUBSCRIPTION_SEAT_LIMIT: {
    status: 409,
    title: "Limite d'employes atteinte",
    body: (p: { plan: string; current: number; max: number }) =>
      `Votre offre ${p.plan} couvre ${p.max} employes et vous en comptez deja ${p.current}.`,
    action: "Passez a l'offre superieure pour ajouter des employes.",
  },
  SUBSCRIPTION_PENDING_PAYMENT: {
    status: 402,
    title: 'Abonnement en attente de paiement',
    body: () => "Votre espace est cree mais le premier paiement n'a pas encore ete confirme.",
    action: "Effectuez le reglement, puis prevenez le support : l'activation est immediate.",
  },

  // ---------------------------------------------------------- Fichiers
  UPLOAD_TOO_LARGE: {
    status: 413,
    title: 'Fichier trop volumineux',
    body: (p: { maxMb: number }) => `La taille maximale autorisee est de ${p.maxMb} Mo.`,
    action: 'Reduisez la taille du fichier, puis reessayez.',
  },
  UPLOAD_INVALID_TYPE: {
    status: 415,
    title: 'Format de fichier refuse',
    body: (p: { allowed: string }) => `Seuls les formats suivants sont acceptes : ${p.allowed}.`,
    action: 'Convertissez votre fichier dans un format accepte.',
  },
  UPLOAD_INFECTED: {
    status: 422,
    title: "Fichier rejete par l'analyse antivirus",
    body: () => "Ce fichier a ete identifie comme dangereux et n'a pas ete conserve.",
    action: 'Verifiez votre appareil, puis transmettez un fichier sain.',
  },

  // ---------------------------------------------------------- Generique
  VALIDATION_FAILED: {
    status: 400,
    title: 'Formulaire incomplet ou invalide',
    body: (p: { fields: string }) => `Champs a corriger : ${p.fields}.`,
    action: 'Corrigez les champs signales, puis validez a nouveau.',
  },
  RATE_LIMITED: {
    status: 429,
    title: 'Trop de requetes',
    body: (p: { retryAfterSeconds: number }) =>
      `Vous avez depasse la limite autorisee. Reessayez dans ${p.retryAfterSeconds} seconde(s).`,
    action: 'Patientez un instant avant de reessayer.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    title: 'Requete incoherente',
    body: () => 'Cette requete reutilise un identifiant deja associe a un contenu different.',
    action: 'Rechargez la page et recommencez.',
  },
  OFFLINE_QUEUED: {
    status: 0,
    title: 'Hors ligne - pointage en attente',
    body: (p: { queued: number }) =>
      `${p.queued} pointage(s) en attente de synchronisation. Ils seront transmis automatiquement au retour du reseau.`,
    action: "Ne fermez pas l'application tant que la synchronisation n'est pas terminee.",
  },
  INTERNAL_ERROR: {
    status: 500,
    title: 'Une erreur technique est survenue',
    body: (p: { requestId: string }) =>
      `L'incident a ete enregistre sous la reference ${p.requestId}. Nos equipes en sont informees.`,
    action:
      'Reessayez dans quelques instants. Si le probleme persiste, transmettez cette reference au support.',
  },
} as const;

export type ErrorCode = keyof typeof ERROR_COPY;

/** Enveloppe d'erreur renvoyee par l'API. */
export interface ApiErrorBody<C extends ErrorCode = ErrorCode> {
  code: C;
  /** Parametres d'interpolation du message. */
  params: Parameters<(typeof ERROR_COPY)[C]['body']>[0];
  /** Correlation avec les journaux serveur. */
  requestId: string;
}

export function errorStatus(code: ErrorCode): number {
  return ERROR_COPY[code].status;
}

/**
 * Rend le message complet pour affichage.
 * Le front n'ecrit jamais de texte d'erreur en dur : il passe par ici.
 */
export function renderError<C extends ErrorCode>(
  code: C,
  params: Parameters<(typeof ERROR_COPY)[C]['body']>[0],
): { title: string; body: string; action?: string } {
  const entry = ERROR_COPY[code] as ErrorEntry<unknown>;
  const rendered: { title: string; body: string; action?: string } = {
    title: entry.title,
    body: entry.body(params),
  };
  if (entry.action !== undefined) rendered.action = entry.action;
  return rendered;
}
