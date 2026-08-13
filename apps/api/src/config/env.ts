import { z } from 'zod';

/**
 * Configuration validee au DEMARRAGE.
 *
 * Le processus refuse de demarrer si une variable est absente ou invalide.
 * C'est volontaire : une API qui demarre avec une cle de chiffrement vide et
 * ne le decouvre qu'au premier pointage est bien pire qu'une API qui ne demarre pas.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    API_URL: z.url(),
    APP_URL: z.url(),
    WEB_URL: z.url(),

    /// Liste blanche d'origines. Jamais "*", jamais l'origine reflechie.
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    DATABASE_URL: z.string().startsWith('postgresql://'),
    REDIS_URL: z.string().startsWith('redis://'),

    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(2),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: z
      .string()
      .default('true')
      .transform((v) => v === 'true'),

    JWT_PRIVATE_KEY_B64: z.string().min(1),
    JWT_PUBLIC_KEY_B64: z.string().min(1),
    JWT_KEY_ID: z.string().min(1).default('k1'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),

    /// 32 octets en base64. Protege les embeddings biometriques et les secrets QR.
    ENCRYPTION_MASTER_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'ENCRYPTION_MASTER_KEY doit valoir exactement 32 octets encodes en base64.',
    }),

    FACE_SERVICE_URL: z.url(),
    FACE_SERVICE_TOKEN: z.string().min(1),
    FACE_MODEL_VERSION: z.string().default('buffalo_l-v1'),

    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().default(1025),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().min(1),

    SMS_PROVIDER: z.enum(['console', 'twilio', 'orange', 'infobip']).default('console'),
    SMS_API_KEY: z.string().optional(),
    SMS_SENDER: z.string().default('POINTAGE'),

    CLAMAV_HOST: z.string().default('localhost'),
    CLAMAV_PORT: z.coerce.number().int().default(3310),

    MAPTILER_API_KEY: z.string().optional(),

    SUPABASE_URL: z.string().optional(),
    SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    SUPABASE_ACCESS_TOKEN: z.string().optional(),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, ctx) => {
    // Garde-fous specifiques a la production : ce sont exactement les valeurs
    // qu'on oublie de changer en passant du portable au serveur.
    if (env.NODE_ENV !== 'production') return;

    const faibles = ['change-me-in-production', 'minioadmin', 'password', 'secret'];
    const aVerifier: [string, string | undefined][] = [
      ['S3_SECRET_KEY', env.S3_SECRET_KEY],
      ['FACE_SERVICE_TOKEN', env.FACE_SERVICE_TOKEN],
      ['SMTP_PASSWORD', env.SMTP_PASSWORD],
    ];

    for (const [nom, valeur] of aVerifier) {
      if (valeur && faibles.some((f) => valeur.toLowerCase().includes(f))) {
        ctx.addIssue({
          code: 'custom',
          path: [nom],
          message: `${nom} porte encore une valeur de developpement. Interdit en production.`,
        });
      }
    }

    if (env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS doit lister explicitement les origines autorisees en production.',
      });
    }

    if (env.CORS_ORIGINS.some((o) => o === '*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message:
          'CORS_ORIGINS ne peut pas valoir "*" : l\'API porte des jetons d\'authentification.',
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  • ${i.path.join('.') || '(racine)'} : ${i.message}`)
      .join('\n');

    // On echoue bruyamment et lisiblement, sans jamais afficher les valeurs.
    throw new Error(
      `Configuration invalide - l'API ne peut pas demarrer :\n${details}\n\n` +
        'Comparez votre .env avec .env.example.',
    );
  }

  return result.data;
}
