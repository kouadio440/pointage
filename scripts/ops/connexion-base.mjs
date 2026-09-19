// Connexion directe a la base Supabase pour les scripts d'exploitation
// (sauvegarde, nettoyage). L'adresse vient de DATABASE_URL (fichier .env du
// poste, jamais commite) ; elle n'est jamais affichee.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Client } = require('pg');

export async function ouvrirBase() {
  const url = process.env.DATABASE_URL || '';
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('DATABASE_URL absente : lancez avec node --env-file=.env ...');
  }
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  await c.connect();
  return c;
}
