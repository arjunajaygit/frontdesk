import { Client } from 'pg';
import { dotenv, roleUrl } from '../helpers/db';

export default async function teardown(): Promise<void> {
  const name = process.env.FRONTDESK_IT_DB;
  const env = dotenv();
  if (!name || !/^frontdesk_it_[0-9a-f]{8}$/.test(name) || !env.MIGRATION_DATABASE_URL) return;
  // Test-only superuser so FORCE can terminate lingering backends of any role; name patterns are checked.
  const admin = new Client({ connectionString: roleUrl('bootstrap', 'postgres') });
  await admin.connect();
  try {
    // Only this run's scratch template and its per-suite clones (name pattern checked above).
    const clones = await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [
      `${name}\\_%`,
    ]);
    for (const { datname } of clones.rows) {
      if (/^frontdesk_it_[0-9a-f]{8}_[a-z0-9_]+$/.test(datname))
        await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
