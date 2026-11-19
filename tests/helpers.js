// Starts an in-memory Postgres (PGlite) and the real server against it, for API tests.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Starts server.js against a database; resolves once it says "Database ready.".
export async function spawnServer(dbUrl, extraEnv = {}) {
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: '0', DATABASE_URL: dbUrl, DATABASE_URL_UNPOOLED: dbUrl, PUBLIC_URL: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const base = await new Promise((resolve, reject) => {
    let port = null;
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 30000);
    const onData = chunk => {
      log += chunk;
      port ??= /Server listening on http:\/\/[^:]+:(\d+)/.exec(log)?.[1];
      if (port && log.includes('Database ready.')) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${log}`)); });
  });
  return {
    base,
    log: () => log,
    stop() { child.removeAllListeners('exit'); child.kill(); },
  };
}

export async function startApp(extraEnv = {}) {
  const db = await PGlite.create();
  const pgServer = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 10 });
  await pgServer.start();
  const pgPort = pgServer.server?.address()?.port ?? pgServer.port;
  const dbUrl = `postgresql://postgres:postgres@127.0.0.1:${pgPort}/postgres`;

  const server = await spawnServer(dbUrl, extraEnv);

  // Direct SQL access for setting up test data.
  const sqlClient = new pg.Client({ connectionString: dbUrl });
  await sqlClient.connect();

  return {
    base: server.base,
    dbUrl,
    sql: (text, params) => sqlClient.query(text, params),
    logs: server.log,
    // Each fake client gets its own IP (the server trusts one proxy hop, so X-Forwarded-For sets req.ip).
    api: async (method, p, { body, ip = '10.0.0.1', headers = {} } = {}) => {
      const res = await fetch(server.base + p, {
        method,
        headers: { 'x-forwarded-for': ip, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json() : await res.text();
      return { status: res.status, data, headers: res.headers };
    },
    async stop() {
      server.stop();
      await sqlClient.end();
      await pgServer.stop();
      await db.close();
    },
  };
}
