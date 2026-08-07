import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Configuration Prisma.
 *
 * Le monorepo n'a qu'UN SEUL fichier .env, a la racine : dupliquer les secrets
 * par application est le meilleur moyen de les voir diverger, puis fuiter.
 * On le charge donc explicitement, puisque Prisma cherche par defaut dans le
 * repertoire courant.
 *
 * On resout depuis process.cwd() plutot que __dirname ou import.meta.url : ce
 * fichier est charge tantot en CommonJS, tantot en ESM selon la commande Prisma,
 * et cwd vaut toujours apps/api (pnpm positionne le repertoire du paquet).
 */
const packageRoot = process.cwd();
loadEnv({ path: path.resolve(packageRoot, '../../.env'), quiet: true });

export default defineConfig({
  schema: path.join(packageRoot, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(packageRoot, 'prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});
