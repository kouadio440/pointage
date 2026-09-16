import fs from 'fs';
import path from 'path';
import pg from '../apps/api/node_modules/pg/lib/index.js';

const { Client } = pg;
// L'URL de connexion vient de l'environnement, jamais du code : elle contient
// le mot de passe du superutilisateur de la base. Le fichier .env est ignore
// par git. Lancer avec :  node --env-file=.env scripts/<ce-script>.mjs
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL absente. Lancez : node --env-file=.env ' + process.argv[1]);
  process.exit(1);
}

async function run() {
  console.log('Connecting to PostgreSQL / Supabase DB...');
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('✅ Connected to Supabase DB.');

    const m007Path = path.resolve('services/supabase_migration_007_fix_leaves_table.sql');
    const m007Sql = fs.readFileSync(m007Path, 'utf8');

    console.log('Executing services/supabase_migration_007_fix_leaves_table.sql...');
    await client.query(m007Sql);
    console.log('✅ Migration 007 executed successfully.');

  } catch (err) {
    console.error('❌ Error executing migration 007:', err);
  } finally {
    await client.end();
  }
}

run();
