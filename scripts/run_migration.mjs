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

    // 1. Lire et exécuter services/supabase_migration_002_attendance.sql
    const m002Path = path.resolve('services/supabase_migration_002_attendance.sql');
    const m002Sql = fs.readFileSync(m002Path, 'utf8');

    console.log('1/2. Executing services/supabase_migration_002_attendance.sql...');
    await client.query(m002Sql);
    console.log('✅ Migration 002 executed successfully.');

    // 2. Lire et exécuter services/supabase_migration_003_rh_config.sql
    const m003Path = path.resolve('services/supabase_migration_003_rh_config.sql');
    const m003Sql = fs.readFileSync(m003Path, 'utf8');

    console.log('2/2. Executing services/supabase_migration_003_rh_config.sql...');
    await client.query(m003Sql);
    console.log('✅ Migration 003 executed successfully.');

    console.log('\n--- VERIFICATION STATS ---');
    const geofencesRes = await client.query('SELECT id, name, radius_meters FROM public.geofences;');
    console.log(`Geofences count: ${geofencesRes.rows.length}`);
    console.table(geofencesRes.rows);

    const schedulesRes = await client.query('SELECT id, name, start_minute, end_minute FROM public.work_schedules;');
    console.log(`Work Schedules count: ${schedulesRes.rows.length}`);
    console.table(schedulesRes.rows);

  } catch (err) {
    console.error('❌ Error executing migrations:', err);
  } finally {
    await client.end();
  }
}

run();
