import assert from 'node:assert/strict';
import test from 'node:test';
import { closeAll, queryLimited } from '../src/db.js';
import { adminClient, configureTestDb, integrationEnabled } from './test-db.js';

configureTestDb();
const integrationTest = integrationEnabled ? test : test.skip;

integrationTest('cursor row limit preserves order and metadata', async () => {
  const admin = adminClient();
  await admin.connect();

  try {
    await admin.query('DROP TABLE IF EXISTS limit_rows');
    await admin.query('CREATE TABLE limit_rows (id int PRIMARY KEY, label text)');
    await admin.query(
      "INSERT INTO limit_rows (id, label) VALUES (3, 'c'), (1, 'a'), (2, 'b'), (4, 'd'), (5, 'e')"
    );

    const limited = await queryLimited('SELECT id, label FROM limit_rows ORDER BY id', undefined, 2);
    assert.equal(limited.rows.length, 2);
    assert.deepEqual(
      limited.rows.map((row) => row.id),
      [1, 2]
    );
    assert.deepEqual(
      limited.fields.map((field) => field.name),
      ['id', 'label']
    );
    assert.equal(limited.truncated, true);

    const exact = await queryLimited('SELECT id FROM limit_rows ORDER BY id', undefined, 10);
    assert.equal(exact.rows.length, 5);
    assert.equal(exact.truncated, false);

    const parameterized = await queryLimited('SELECT label FROM limit_rows WHERE id = $1', [4], 10);
    assert.deepEqual(parameterized.rows, [{ label: 'd' }]);

    const show = await queryLimited('SHOW server_version', undefined, 10);
    assert.equal(show.rows.length, 1);
    assert.equal(show.truncated, false);
    assert.equal(show.fields.length, 1);

    const explain = await queryLimited('EXPLAIN SELECT * FROM limit_rows', undefined, 1);
    assert.equal(explain.rows.length, 1);
    assert.equal(explain.truncated, false);
    assert.ok(explain.fields.some((field) => field.name === 'QUERY PLAN'));

    const empty = await queryLimited('SELECT id FROM limit_rows WHERE id = -1', undefined, 10);
    assert.equal(empty.rows.length, 0);
    assert.deepEqual(
      empty.fields.map((field) => field.name),
      ['id']
    );
    assert.equal(empty.truncated, false);
  } finally {
    await admin.query('DROP TABLE IF EXISTS limit_rows');
    await admin.end();
    await closeAll();
  }
});
