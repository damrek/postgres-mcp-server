import assert from 'node:assert/strict';
import test from 'node:test';
import { closeAll, query } from '../src/db.js';
import {
  columnsQuery,
  constraintsQuery,
  indexesQuery,
  mapConstraints,
  mapRelationships,
  relationshipsQuery,
} from '../src/catalog.js';
import { adminClient, configureTestDb, integrationEnabled } from './test-db.js';

configureTestDb();
const integrationTest = integrationEnabled ? test : test.skip;

integrationTest('catalog queries resolve composite foreign keys and constraint collisions', async () => {
  const admin = adminClient();
  await admin.connect();

  try {
    await admin.query('DROP SCHEMA IF EXISTS phase2 CASCADE');
    await admin.query('DROP TABLE IF EXISTS child, parent, audit, orders, customers CASCADE');
    await admin.query(`CREATE TABLE customers (
      id int PRIMARY KEY,
      email text UNIQUE,
      name text CONSTRAINT customers_name_check CHECK (length(name) > 0)
    )`);
    await admin.query(`CREATE TABLE orders (
      id int PRIMARY KEY,
      customer_id int REFERENCES customers(id),
      status text CONSTRAINT orders_status_check CHECK (status <> '')
    )`);
    await admin.query(`CREATE TABLE audit (
      id int PRIMARY KEY,
      note text CONSTRAINT orders_status_check CHECK (length(note) < 100)
    )`);
    await admin.query('CREATE TABLE parent (a int, b int, PRIMARY KEY (a, b))');
    await admin.query(`CREATE TABLE child (
      x int,
      y int,
      CONSTRAINT child_parent_fk FOREIGN KEY (x, y) REFERENCES parent(a, b)
    )`);
    await admin.query('CREATE SCHEMA phase2');
    await admin.query(`CREATE TABLE phase2.customers (
      id int PRIMARY KEY,
      email text CONSTRAINT customers_name_check CHECK (email <> '')
    )`);
    await admin.query(`CREATE TABLE phase2.orders (
      id int PRIMARY KEY,
      customer_id int CONSTRAINT phase2_orders_customer_fk REFERENCES phase2.customers(id),
      CONSTRAINT orders_status_check CHECK (id > 0)
    )`);

    const allLookup = relationshipsQuery();
    const relationships = mapRelationships((await query(allLookup.sql, allLookup.params)).rows);

    const composite = relationships.filter(
      (rel) =>
        rel.constraint_name === 'child_parent_fk' &&
        rel.source_schema === 'public' &&
        rel.source_table === 'child' &&
        rel.target_schema === 'public' &&
        rel.target_table === 'parent'
    );
    assert.deepEqual(
      composite.map((rel) => [rel.source_column, rel.target_column]),
      [
        ['x', 'a'],
        ['y', 'b'],
      ]
    );

    const publicOrders = relationships.find(
      (rel) =>
        rel.source_schema === 'public' &&
        rel.source_table === 'orders' &&
        rel.constraint_name === 'orders_customer_id_fkey'
    );
    assert.equal(publicOrders?.target_schema, 'public');
    assert.equal(publicOrders?.target_table, 'customers');

    const otherOrders = relationships.find((rel) => rel.constraint_name === 'phase2_orders_customer_fk');
    assert.equal(otherOrders?.source_schema, 'phase2');
    assert.equal(otherOrders?.target_schema, 'phase2');
    assert.equal(otherOrders?.target_table, 'customers');

    assert.equal(
      relationships.some((rel) => rel.source_schema === 'phase2' && rel.target_schema === 'public'),
      false
    );

    const byTable = relationshipsQuery({ tableName: 'child' });
    const byTableRows = mapRelationships((await query(byTable.sql, byTable.params)).rows);
    assert.deepEqual(
      byTableRows
        .filter((rel) => rel.source_schema === 'public' && rel.source_table === 'child')
        .map((rel) => [rel.source_column, rel.target_column]),
      [
        ['x', 'a'],
        ['y', 'b'],
      ]
    );

    const byTarget = relationshipsQuery({ tableName: 'parent' });
    const byTargetRows = mapRelationships((await query(byTarget.sql, byTarget.params)).rows);
    assert.equal(
      byTargetRows.filter((rel) => rel.target_schema === 'public' && rel.target_table === 'parent').length,
      2
    );

    const byQualified = relationshipsQuery({ tableName: 'public.orders' });
    const qualified = mapRelationships((await query(byQualified.sql, byQualified.params)).rows);
    assert.equal(qualified.length, 1);
    assert.equal(qualified[0]?.constraint_name, 'orders_customer_id_fkey');

    const childLookup = constraintsQuery('child', 'public');
    const childConstraints = mapConstraints((await query(childLookup.sql, childLookup.params)).rows);
    const childFk = childConstraints.find((constraint) => constraint.name === 'child_parent_fk');
    assert.equal(childFk?.type, 'FOREIGN KEY');
    assert.deepEqual(childFk?.columns, ['x', 'y']);
    assert.match(childFk?.definition ?? '', /FOREIGN KEY \(x, y\) REFERENCES parent\(a, b\)/);

    const ordersLookup = constraintsQuery('orders', 'public');
    const ordersConstraints = mapConstraints((await query(ordersLookup.sql, ordersLookup.params)).rows);
    const ordersCheck = ordersConstraints.find((constraint) => constraint.name === 'orders_status_check');
    assert.match(ordersCheck?.definition ?? '', /status/);
    assert.equal(
      ordersConstraints.some((constraint) => constraint.type === 'FOREIGN KEY'),
      true
    );
    assert.equal(
      ordersConstraints.some((constraint) => constraint.type === 'PRIMARY KEY'),
      true
    );

    const auditLookup = constraintsQuery('audit', 'public');
    const auditConstraints = mapConstraints((await query(auditLookup.sql, auditLookup.params)).rows);
    const auditCheck = auditConstraints.find((constraint) => constraint.name === 'orders_status_check');
    assert.match(auditCheck?.definition ?? '', /note/);
    assert.doesNotMatch(auditCheck?.definition ?? '', /status/);

    const customersLookup = constraintsQuery('customers', 'public');
    const customersConstraints = mapConstraints(
      (await query(customersLookup.sql, customersLookup.params)).rows
    );
    assert.deepEqual(
      customersConstraints.map((constraint) => constraint.type).sort(),
      ['CHECK', 'PRIMARY KEY', 'UNIQUE']
    );

    const columnsLookup = columnsQuery('customers', 'public');
    const columnRows = await query(columnsLookup.sql, columnsLookup.params);
    assert.deepEqual(
      columnRows.rows.map((row) => row.column_name),
      ['id', 'email', 'name']
    );

    const indexesLookup = indexesQuery('customers', 'public');
    const indexRows = await query(indexesLookup.sql, indexesLookup.params);
    assert.equal(indexRows.rows.length >= 2, true);
  } finally {
    await admin.query('DROP SCHEMA IF EXISTS phase2 CASCADE');
    await admin.query('DROP TABLE IF EXISTS child, parent, audit, orders, customers CASCADE');
    await admin.end();
    await closeAll();
  }
});
