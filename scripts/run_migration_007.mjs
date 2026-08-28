import fs from 'fs';
import path from 'path';
import pg from '../apps/api/node_modules/pg/lib/index.js';

const { Client } = pg;
const dbUrl = 'postgresql://postgres:XsNqlKxJwAqskDh3@db.hwfcshufofzfjinlvdya.supabase.co:5432/postgres';

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
