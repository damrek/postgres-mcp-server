import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { closeAll, query } from '../src/db.js';

const host = process.env.TEST_DB_HOST;
const enabled = Boolean(host);

if (host) {
  process.env.DB_HOST = host;
  process.env.DB_PORT = process.env.TEST_DB_PORT ?? '5432';
  process.env.DB_USER = process.env.TEST_DB_USER ?? 'postgres';
  process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD ?? '';
  process.env.DB_NAME = process.env.TEST_DB_NAME ?? 'postgres';
}

const integrationTest = enabled ? test : test.skip;

function adminClient(): pg.Client {
  return new pg.Client({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}

integrationTest('read-only boundary rejects writes and keeps data intact', async () => {
  const admin = adminClient();
  await admin.connect();

  try {
    await admin.query('DROP TABLE IF EXISTS probe_rows');
    await admin.query('CREATE TABLE probe_rows (id int PRIMARY KEY)');
    await admin.query('INSERT INTO probe_rows (id) VALUES (1)');

    await assert.rejects(query('DELETE FROM probe_rows'), /read-only transaction|Query rejected/);
    await assert.rejects(
      query('EXPLAIN ANALYZE CREATE TABLE probe_ctas AS SELECT * FROM probe_rows'),
      /Query rejected/
    );
    await assert.rejects(
      query('SET default_transaction_read_only = off; COMMIT; DELETE FROM probe_rows'),
      /Query rejected/
    );
    await assert.rejects(query('SELECT * INTO probe_into FROM probe_rows'), /Query rejected/);

    const counted = await query('SELECT count(*)::int AS count FROM probe_rows');
    assert.equal(counted.rows[0]?.count, 1);

    const explained = await query('EXPLAIN ANALYZE SELECT * FROM probe_rows');
    assert.ok(explained.rows.length > 0);

    const created = await query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('probe_ctas', 'probe_into')"
    );
    assert.equal(created.rows.length, 0);
  } finally {
    await admin.query('DROP TABLE IF EXISTS probe_ctas');
    await admin.query('DROP TABLE IF EXISTS probe_into');
    await admin.query('DROP TABLE IF EXISTS probe_rows');
    await admin.end();
    await closeAll();
  }
});
