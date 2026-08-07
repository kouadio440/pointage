/**
 * Schemas de validation partages.
 *
 * L'API les utilise pour valider les requetes (via nestjs-zod) ET le front
 * pour valider les formulaires (via @hookform/resolvers/zod). Un seul contrat,
 * donc aucune divergence possible entre ce que le formulaire accepte et ce que
 * le serveur accepte.
 *
 * Tous les objets sont STRICTS : une cle inconnue est REJETEE, pas silencieusement
 * retiree. Retirer masque les bugs du client ; rejeter les revele immediatement.
 */

import { z } from 'zod';

// ------------------------------------------------------------------ Primitives

/** Format du code entreprise remis aux employes : "WDS-4821". */
export const companyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}-\d{4}$/, 'Le code entreprise doit ressembler a WDS-4821.');

/**
 * Numero de telephone au format international.
 * Les pays cibles (CI +225, SN +221, CM +237, BF +226, ML +223) ont des
 * longueurs nationales differentes : on valide la forme, pas l'operateur.
 */
export const phoneSchema = z
  .string()
  .trim()
  .regex(
    /^\+[1-9]\d{7,14}$/,
    'Numero attendu au format international, par exemple +2250700000000.',
  );

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Adresse e-mail invalide.')
  .max(254);

/**
 * Mot de passe.
 *
 * On impose une LONGUEUR minimale plutot qu'une composition exotique : les
 * regles du type "une majuscule, un chiffre, un caractere special" produisent
 * surtout des mots de passe previsibles notes sur un papier. 12 caracteres
 * minimum, et le reste est traite par argon2id et la limitation de tentatives.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Le mot de passe doit contenir au moins 12 caracteres.')
  .max(200, 'Le mot de passe ne peut pas depasser 200 caracteres.');

/** Matricule interne : alphanumerique, tirets et points admis. */
export const matriculeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(24)
  .regex(
    /^[A-Z0-9.\-]+$/,
    'Le matricule ne peut contenir que des lettres, chiffres, points et tirets.',
  );

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

/** Date metier "2026-08-06". */
export const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.');

/** Heure "08:00". */
export const hourMinuteSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure attendue au format HH:MM.');

// ------------------------------------------------------------ Inscription

export const companySignupSchema = z
  .object({
    companyName: z.string().trim().min(2).max(120),
    sector: z.string().trim().min(2).max(80),
    country: z.string().trim().length(2).toUpperCase(),
    city: z.string().trim().min(2).max(80),
    timezone: z.string().trim().min(3).max(64).default('Africa/Abidjan'),

    ceoFirstName: z.string().trim().min(1).max(60),
    ceoLastName: z.string().trim().min(1).max(60),
    ceoEmail: emailSchema,
    ceoPhone: phoneSchema,
    password: passwordSchema,

    planCode: z.enum(['STARTER', 'BUSINESS', 'ENTERPRISE']),
    billingPeriod: z.enum(['MONTHLY', 'ANNUAL']),

    acceptTerms: z.literal(true, {
      message: "Vous devez accepter les conditions d'utilisation.",
    }),
  })
  .strict();

export type CompanySignupInput = z.infer<typeof companySignupSchema>;

// ------------------------------------------------------------- Connexion

/** Connexion CEO / RH / Manager / Super Admin. */
export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Mot de passe requis.'),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Connexion employe : code entreprise + matricule.
 *
 * Beaucoup d'employes de terrain (ouvriers, agents de securite, commerciaux)
 * n'ont pas d'adresse e-mail professionnelle. Le RH cree le compte et remet
 * les identifiants ; l'e-mail reste accepte en alternative pour ceux qui en ont un.
 */
export const employeeLoginSchema = z
  .object({
    companyCode: companyCodeSchema,
    matricule: matriculeSchema,
    password: z.string().min(1, 'Mot de passe requis.'),
  })
  .strict();

export type EmployeeLoginInput = z.infer<typeof employeeLoginSchema>;

export const requestOtpSchema = z.object({ phone: phoneSchema }).strict();

export const verifyOtpSchema = z
  .object({
    phone: phoneSchema,
    code: z.string().regex(/^\d{6}$/, 'Le code de verification comporte 6 chiffres.'),
  })
  .strict();

export const requestPasswordResetSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(200),
    password: passwordSchema,
  })
  .strict();

// -------------------------------------------------------------- Pointage

export const punchTypeSchema = z.enum(['IN', 'OUT', 'BREAK_START', 'BREAK_END']);
export const punchMethodSchema = z.enum(['GPS_SELFIE', 'QR_KIOSK', 'MANUAL_HR', 'NFC_BADGE']);

/**
 * Signaux d'attestation natifs.
 *
 * TOUS optionnels et laisses vides par la PWA : un navigateur ne peut pas les
 * produire. La coque Capacitor (phase 8) les remplira sans modifier ce contrat.
 * Les declarer maintenant evite une migration d'API plus tard.
 */
export const nativeSignalsSchema = z
  .object({
    mockLocation: z.boolean().optional(),
    rooted: z.boolean().optional(),
    emulator: z.boolean().optional(),
    /** Jeton Play Integrity (Android) ou App Attest (iOS). */
    attestationToken: z.string().max(8192).optional(),
    /** Identifiants de balises BLE percues, pour le pointage par proximite. */
    beaconIds: z.array(z.string().max(64)).max(20).optional(),
  })
  .strict();

export const createPunchSchema = z
  .object({
    type: punchTypeSchema,
    method: punchMethodSchema,

    /** Position rapportee par le client. Recalculee et arbitree cote serveur. */
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    accuracyM: z.number().min(0).max(100_000),

    /** Site vise. Si absent, le serveur resout le site affecte a l'employe. */
    siteId: z.uuid().optional(),

    /**
     * Heure declaree par l'appareil. N'a JAMAIS autorite : elle sert uniquement
     * a mesurer le decalage d'horloge et a dater un pointage differe hors ligne.
     */
    clientTime: z.iso.datetime(),

    /** Cle du selfie deja televerse en stockage objet via URL presignee. */
    selfieKey: z.string().max(512).optional(),

    /** Jeton du QR dynamique, quand la methode est QR_KIOSK. */
    qrToken: z.string().max(512).optional(),

    /** Empreinte d'appareil stable, calculee cote client. */
    deviceFingerprint: z.string().min(8).max(128),

    /** Rempli uniquement quand le pointage a ete mis en file hors ligne. */
    offlineQueuedAt: z.iso.datetime().optional(),

    nativeSignals: nativeSignalsSchema.optional(),
  })
  .strict();

export type CreatePunchInput = z.infer<typeof createPunchSchema>;

/** Pointage saisi par le RH pour le compte d'un employe (module 5). */
export const manualPunchSchema = z
  .object({
    employeeId: z.uuid(),
    type: punchTypeSchema,
    occurredAt: z.iso.datetime(),
    siteId: z.uuid(),
    /** Obligatoire : un pointage manuel sans justification n'est pas auditable. */
    reason: z
      .string()
      .trim()
      .min(10, 'Precisez le motif de la saisie manuelle (10 caracteres minimum).')
      .max(500),
  })
  .strict();

export type ManualPunchInput = z.infer<typeof manualPunchSchema>;

// -------------------------------------------------------------- Pagination

export const paginationSchema = z
  .object({
    cursor: z.string().max(200).optional(),
    /** Plafond dur : une liste ne renvoie jamais plus de 200 lignes. */
    take: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const dateRangeSchema = z
  .object({
    from: businessDateSchema,
    to: businessDateSchema,
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: 'La date de debut doit preceder la date de fin.',
    path: ['from'],
  })
  .refine(
    (v) => {
      const days = (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000;
      return days <= 366;
    },
    { message: 'La periode ne peut pas depasser 366 jours.', path: ['to'] },
  );
