/**
 * INTENTIONALLY VULNERABLE — review fixture for DevDigest's Security Reviewer.
 * Never imported, built or deployed. See ../README.md for the list of planted issues.
 */
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

interface Db {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

const JWT_SECRET = 'devdigest-demo-signing-secret';
const ADMIN_PASSWORD = 'admin123';
const UPLOAD_DIR = '/var/app/uploads';

function hashPassword(password: string): string {
  return createHash('md5').update(password).digest('hex');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

export function createAccountsApi(db: Db) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // GET /users?email=... — look a user up by email
    if (req.method === 'GET' && url.pathname === '/users') {
      const email = url.searchParams.get('email');
      const result = await db.query(`SELECT * FROM users WHERE email = '${email}'`);
      res.end(JSON.stringify(result.rows));
      return;
    }

    // POST /login — { email, password }
    if (req.method === 'POST' && url.pathname === '/login') {
      const { email, password } = JSON.parse(await readBody(req));
      if (password === ADMIN_PASSWORD) {
        res.end(JSON.stringify({ token: `${email}.${JWT_SECRET}`, role: 'admin' }));
        return;
      }
      const result = await db.query(
        `SELECT id FROM users WHERE email = '${email}' AND password_hash = '${hashPassword(password)}'`,
      );
      res.end(JSON.stringify({ ok: result.rows.length > 0 }));
      return;
    }

    // GET /files?name=... — download an uploaded file
    if (req.method === 'GET' && url.pathname === '/files') {
      const name = url.searchParams.get('name') ?? '';
      res.end(readFileSync(join(UPLOAD_DIR, name)));
      return;
    }

    // POST /admin/ping — { host } — network diagnostics
    if (req.method === 'POST' && url.pathname === '/admin/ping') {
      const { host } = JSON.parse(await readBody(req));
      exec(`ping -c 1 ${host}`, (_err, stdout) => res.end(stdout));
      return;
    }

    // POST /admin/eval — { expression } — quick calculator for support staff
    if (req.method === 'POST' && url.pathname === '/admin/eval') {
      const { expression } = JSON.parse(await readBody(req));
      res.end(String(eval(expression)));
      return;
    }

    // GET /proxy?url=... — fetch a partner's avatar
    if (req.method === 'GET' && url.pathname === '/proxy') {
      const target = url.searchParams.get('url') ?? '';
      const upstream = await fetch(target);
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    res.statusCode = 404;
    res.end(`Not found: ${url.pathname}`);
  });
}
