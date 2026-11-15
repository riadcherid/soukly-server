// Accès base de données — Postgres local (Pool `pg`).
// Toute la SQL passe par ce module : all / get / run / transaction / initSchema.
// Connexion via DATABASE_URL (défaut : base locale `soukly`).
// Le schéma est dans schema.sql.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgres://soukly:soukly-dev-only@localhost:5432/soukly';

const pool = new pg.Pool({ connectionString: DATABASE_URL });

pool.on('error', (err) => {
  console.error('[db] erreur inattendue du pool Postgres :', err.message);
});

export async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

export async function all(sql, ...params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function get(sql, ...params) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

export async function run(sql, ...params) {
  return pool.query(sql, params);
}

export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const api = {
      all: async (sql, ...p) => (await client.query(sql, p)).rows,
      get: async (sql, ...p) => (await client.query(sql, p)).rows[0] || null,
      run: async (sql, ...p) => client.query(sql, p),
    };
    const result = await fn(api);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function close() {
  await pool.end();
}
