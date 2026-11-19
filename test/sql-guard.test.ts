import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRowLimit, checkReadOnlySql, checkTableName, checkWhereClause } from '../src/sql-guard.js';

test('accepts read-only statements', () => {
  const queries = [
    'SELECT * FROM users',
    'select 1',
    'WITH recent AS (SELECT * FROM users) SELECT * FROM recent',
    'EXPLAIN SELECT * FROM users',
    'EXPLAIN (FORMAT JSON) SELECT * FROM users',
    'EXPLAIN ANALYZE SELECT * FROM users',
    'EXPLAIN (ANALYZE true, FORMAT JSON) SELECT 1',
    'SHOW server_version',
    'TABLE users',
    'VALUES (1), (2)',
    "SELECT 'a;b' AS value",
    "SELECT E'It\\'s a; test' AS value",
    'SELECT 1 -- DELETE FROM users',
    'SELECT $$DELETE FROM users$$ AS body',
    '/* SELECT */ SELECT 1',
  ];
  for (const sql of queries) {
    assert.equal(checkReadOnlySql(sql).valid, true, sql);
  }
});

test('rejects data-modifying and utility statements', () => {
  const queries = [
    'DELETE FROM users',
    'UPDATE users SET name = $1',
    'INSERT INTO users (name) VALUES ($1)',
    'DROP TABLE users',
    'ALTER TABLE users ADD COLUMN x int',
    'CREATE TABLE t (id int)',
    'TRUNCATE users',
    'GRANT SELECT ON users TO public',
    'SET default_transaction_read_only = off',
    'CALL maintenance()',
    'DO $$ BEGIN DELETE FROM users; END $$',
    'COPY users TO STDOUT',
    'VACUUM users',
    '/* harmless */ DELETE FROM users',
    'SELECT * INTO x FROM users',
  ];
  for (const sql of queries) {
    assert.equal(checkReadOnlySql(sql).valid, false, sql);
  }
});

test('rejects multiple statements', () => {
  const queries = [
    'SELECT 1; DELETE FROM users',
    'SELECT 1; SET default_transaction_read_only = off',
    'SELECT 1; SELECT 2',
  ];
  for (const sql of queries) {
    assert.equal(checkReadOnlySql(sql).valid, false, sql);
  }
});

test('rejects data-modifying CTEs and EXPLAIN ANALYZE writes', () => {
  const queries = [
    'WITH removed AS (DELETE FROM users RETURNING *) SELECT * FROM removed',
    'WITH changed AS (UPDATE users SET name = $1 RETURNING *) SELECT * FROM changed',
    'EXPLAIN ANALYZE DELETE FROM users',
    'EXPLAIN ANALYZE CREATE TABLE x AS SELECT 1',
    'EXPLAIN ANALYZE CREATE MATERIALIZED VIEW m AS SELECT 1',
    'EXPLAIN ANALYZE SELECT * INTO x FROM users',
    'EXPLAIN (ANALYZE true) CREATE TABLE x AS SELECT 1',
    'EXPLAIN CREATE TABLE x AS SELECT 1',
  ];
  for (const sql of queries) {
    assert.equal(checkReadOnlySql(sql).valid, false, sql);
  }
});

test('rejects locking selects', () => {
  const queries = [
    'SELECT * FROM users FOR UPDATE',
    'SELECT * FROM users FOR NO KEY UPDATE',
    'SELECT * FROM users FOR SHARE',
    'SELECT * FROM users FOR KEY SHARE',
  ];
  for (const sql of queries) {
    assert.equal(checkReadOnlySql(sql).valid, false, sql);
  }
});

test('rejects unterminated literals and comments', () => {
  const queries = ["SELECT 'unterminated", 'SELECT 1 /* unterminated', 'SELECT "unterminated', 'SELECT $tag$unterminated'];
  for (const sql of queries) {
    assert.equal(checkReadOnlySql(sql).valid, false, sql);
  }
});

test('validates table names', () => {
  assert.equal(checkTableName('users').valid, true);
  assert.equal(checkTableName('public.users').valid, true);
  assert.equal(checkTableName('audit_log').valid, true);
  const invalidNames = ['', 'users; DROP TABLE x', 'public.users.extra', '1users', 'users)', ' users', 'users--', 'users"'];
  for (const name of invalidNames) {
    assert.equal(checkTableName(name).valid, false, name);
  }
});

test('validates where clauses', () => {
  assert.equal(checkWhereClause('active = true').valid, true);
  assert.equal(checkWhereClause("name = 'a;b'").valid, true);
  assert.equal(checkWhereClause("name = E'It\\'s; x'").valid, true);
  assert.equal(checkWhereClause("created_at > now() - interval '1 day'").valid, true);
  assert.equal(checkWhereClause('1=1 -- trailing comment').valid, true);
  const invalidClauses = ['', '1=1; DELETE FROM users', "name = 'x'; SET default_transaction_read_only = off", '1=1; DROP TABLE users'];
  for (const clause of invalidClauses) {
    assert.equal(checkWhereClause(clause).valid, false, clause);
  }
});

test('applies row limits only to statements that return rows', () => {
  assert.equal(applyRowLimit('SHOW server_version', 100), 'SHOW server_version');
  assert.equal(applyRowLimit('EXPLAIN SELECT 1', 100), 'EXPLAIN SELECT 1');
  assert.equal(applyRowLimit('SELECT * FROM users;', 100), 'SELECT * FROM users LIMIT 100');
  assert.equal(applyRowLimit('SELECT * FROM users LIMIT 10;', 100), 'SELECT * FROM users LIMIT 10');
  assert.equal(applyRowLimit("SELECT 'LIMIT 5' AS value", 100), "SELECT 'LIMIT 5' AS value LIMIT 100");
});
