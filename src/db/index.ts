import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

// Local databases don't use SSL; hosted ones (Neon, Supabase, Cloud SQL public IP) require it.
const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '::1'].includes(host);

function poolConfig() {
  const url = process.env.DATABASE_URL;
  if (url) {
    // Preferred: one connection string, e.g. from Neon:
    // postgresql://user:password@ep-xxx-pooler.region.aws.neon.tech/dbname?sslmode=require
    // TLS is set explicitly below (full certificate verification), so drop the URL's sslmode,
    // which pg would otherwise reinterpret with a deprecation warning.
    const parsed = new URL(url);
    parsed.searchParams.delete('sslmode');
    return {
      connectionString: parsed.toString(),
      ssl: isLocalHost(parsed.hostname) ? false : { rejectUnauthorized: true },
    };
  }
  // Fallback: separate SQL_* variables (the original Cloud SQL setup).
  return {
    host: process.env.SQL_HOST,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: process.env.SQL_DB_NAME,
  };
}

export const createPool = () => {
  if (!global._postgresPool) {
    global._postgresPool = new Pool({
      ...poolConfig(),
      max: 5, // free tiers limit connections; a small pool is plenty for this app
      connectionTimeoutMillis: 15000, // Neon's free tier sleeps when idle; the first connect can take a moment
      idleTimeoutMillis: 30000,
    });

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

export const pool = createPool();
export const db = drizzle(pool, { schema });

// Creates the tables if they don't exist yet, so a brand-new database (e.g. a fresh Neon project)
// works without running drizzle-kit. Matches src/db/schema.ts; safe to run on every start.
// Schema changes go over the direct (unpooled) connection when available, as Neon recommends;
// app queries keep using the pooled DATABASE_URL.
export async function ensureSchema() {
  const directUrl = process.env.DATABASE_URL_UNPOOLED;
  if (!directUrl) return runSchemaSql(pool);
  const parsed = new URL(directUrl);
  parsed.searchParams.delete('sslmode');
  const client = new Client({
    connectionString: parsed.toString(),
    ssl: isLocalHost(parsed.hostname) ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  try {
    await runSchemaSql(client);
  } finally {
    await client.end();
  }
}

async function runSchemaSql(conn: { query: (sql: string) => Promise<unknown> }) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS users (
      id serial PRIMARY KEY,
      uid text NOT NULL UNIQUE,
      email text NOT NULL,
      display_name text,
      created_at timestamp DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reports (
      id serial PRIMARY KEY,
      user_id integer REFERENCES users(id),
      type text NOT NULL,
      status text NOT NULL,
      area text NOT NULL,
      details text NOT NULL,
      who text,
      lat double precision,
      lng double precision,
      approximate boolean DEFAULT true,
      time timestamp DEFAULT now(),
      created_at timestamp DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS reports_time_idx ON reports (time DESC);
    CREATE INDEX IF NOT EXISTS reports_user_id_idx ON reports (user_id);
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS water_level text;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS reviewed boolean DEFAULT false;
    CREATE TABLE IF NOT EXISTS report_flags (
      report_id integer NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      voter_key text NOT NULL,
      created_at timestamp DEFAULT now(),
      PRIMARY KEY (report_id, voter_key)
    );
    CREATE TABLE IF NOT EXISTS hotspots (
      id serial PRIMARY KEY,
      name_ms text NOT NULL,
      name_en text NOT NULL,
      note_ms text NOT NULL DEFAULT '',
      note_en text NOT NULL DEFAULT '',
      lat double precision NOT NULL,
      lng double precision NOT NULL,
      days integer NOT NULL DEFAULT 0,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS report_confirmations (
      report_id integer NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      voter_key text NOT NULL,
      created_at timestamp DEFAULT now(),
      PRIMARY KEY (report_id, voter_key)
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint text PRIMARY KEY,
      p256dh text NOT NULL,
      auth text NOT NULL,
      lat double precision NOT NULL,
      lng double precision NOT NULL,
      radius_km integer NOT NULL,
      lang text NOT NULL DEFAULT 'ms',
      created_at timestamp DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS report_photos (
      report_id integer PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
      mime text NOT NULL,
      thumb bytea NOT NULL,
      full_image bytea NOT NULL,
      bytes integer NOT NULL,
      created_at timestamp DEFAULT now()
    );
  `);
}
