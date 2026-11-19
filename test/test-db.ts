import pg from 'pg';

export const integrationEnabled = Boolean(process.env.TEST_DB_HOST);

export function configureTestDb(): void {
  const host = process.env.TEST_DB_HOST;
  if (!host) {
    return;
  }
  process.env.DB_HOST = host;
  process.env.DB_PORT = process.env.TEST_DB_PORT ?? '5432';
  process.env.DB_USER = process.env.TEST_DB_USER ?? 'postgres';
  process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD ?? '';
  process.env.DB_NAME = process.env.TEST_DB_NAME ?? 'postgres';
}

export function adminClient(): pg.Client {
  return new pg.Client({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}
