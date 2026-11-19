import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPoolConfig } from '../src/db.js';

test('buildPoolConfig applies connection defaults', () => {
  const config = buildPoolConfig({});
  assert.equal(config.host, 'localhost');
  assert.equal(config.port, 5432);
  assert.equal(config.user, 'postgres');
  assert.equal(config.max, 5);
  assert.equal(config.application_name, 'postgres-mcp-server');
});

test('buildPoolConfig enforces read-only transactions on every connection', () => {
  const config = buildPoolConfig({});
  assert.match(config.options, /default_transaction_read_only=on/);
});

test('buildPoolConfig applies statement, query, and connect timeouts', () => {
  const config = buildPoolConfig({});
  assert.equal(config.statement_timeout, 15000);
  assert.equal(config.query_timeout, 20000);
  assert.equal(config.connectionTimeoutMillis, 10000);
});

test('buildPoolConfig honors environment overrides', () => {
  const config = buildPoolConfig({
    DB_HOST: 'db.internal',
    DB_PORT: '6543',
    DB_USER: 'reader',
    DB_PASSWORD: 'secret',
    DB_NAME: 'analytics',
    DB_STATEMENT_TIMEOUT: '2500',
    DB_CONNECT_TIMEOUT: '3000',
  });
  assert.equal(config.host, 'db.internal');
  assert.equal(config.port, 6543);
  assert.equal(config.user, 'reader');
  assert.equal(config.password, 'secret');
  assert.equal(config.database, 'analytics');
  assert.equal(config.statement_timeout, 2500);
  assert.equal(config.query_timeout, 7500);
  assert.equal(config.connectionTimeoutMillis, 3000);
});

test('buildPoolConfig falls back to defaults for invalid values', () => {
  const config = buildPoolConfig({
    DB_PORT: 'not-a-port',
    DB_STATEMENT_TIMEOUT: '0',
    DB_CONNECT_TIMEOUT: '-5',
  });
  assert.equal(config.port, 5432);
  assert.equal(config.statement_timeout, 15000);
  assert.equal(config.connectionTimeoutMillis, 10000);
});
