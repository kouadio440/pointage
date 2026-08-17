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

    // 1. Lire et exécuter services/supabase_schema.sql
    const schemaPath = path.resolve('services/supabase_schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    console.log('1/4. Executing services/supabase_schema.sql...');
    await client.query(schemaSql);
    console.log('✅ Base schema executed successfully.');

    // 2. Lire et exécuter services/supabase_migration_002_attendance.sql
    const migrationPath = path.resolve('services/supabase_migration_002_attendance.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    console.log('2/4. Executing services/supabase_migration_002_attendance.sql...');
    await client.query(migrationSql);
    console.log('✅ Migration 002 executed successfully.');

    // 3. Récupérer ou créer l'entreprise de test
    let companyId = null;
    const companyRes = await client.query(`SELECT id, name FROM public.companies LIMIT 1;`);
    if (companyRes.rows.length > 0) {
      companyId = companyRes.rows[0].id;
      console.log(`Found existing company: ${companyRes.rows[0].name} (${companyId})`);
    } else {
      const newCompanyRes = await client.query(`
        INSERT INTO public.companies (name, siret_or_rccm, plan, status, company_code)
        VALUES ('Winner Corp CI', 'CI-ABJ-2024-B-12345', 'pro', 'active', 'WIN-2026-CI')
        RETURNING id, name;
      `);
      companyId = newCompanyRes.rows[0].id;
      console.log(`✅ Created test company: ${newCompanyRes.rows[0].name} (${companyId})`);
    }

    // 4. Créer un site géofencé dans geofences
    console.log('3/4. Creating site in geofences...');
    const siteRes = await client.query(`
      INSERT INTO public.geofences (
        company_id, name, address, latitude, longitude, radius_meters, is_headquarters, is_active
      ) VALUES (
        $1, 'Siège Principal - Abidjan Plateau', 'Avenue Chardy, Abidjan Plateau', 5.3261, -4.0211, 200, TRUE, TRUE
      )
      RETURNING id, name, latitude, longitude, radius_meters;
    `, [companyId]);

    const site = siteRes.rows[0];
    const siteId = site.id;
    console.log(`✅ Geofence site created: "${site.name}" (ID: ${siteId}, Lat: ${site.latitude}, Lon: ${site.longitude}, Radius: ${site.radius_meters}m)`);

    // 5. Renseigner users.site_id pour l'employé (ou tous les utilisateurs sans site_id)
    console.log('4/4. Updating users.site_id...');
    const updateUsersRes = await client.query(`
      UPDATE public.users
      SET site_id = $1, company_id = $2
      WHERE site_id IS NULL OR site_id = $1;
    `, [siteId, companyId]);

    console.log(`✅ Updated users count: ${updateUsersRes.rowCount}`);

    const usersRes = await client.query(`SELECT id, full_name, email, role, company_id, site_id FROM public.users;`);
    console.log('Current Users in DB:');
    console.table(usersRes.rows);

  } catch (err) {
    console.error('❌ Error executing database operations:', err);
  } finally {
    await client.end();
  }
}

run();
