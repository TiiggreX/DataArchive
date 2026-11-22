// Registro documental — sin dependencias npm. Requiere Node >= 22.13 (node:sqlite).
import http from 'node:http';
import { Readable } from 'node:stream';
import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// --- Configuración (.env) ---
try {
  for (const l of readFileSync('.env', 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] ??= m[2];
  }
} catch {}
const {
  S3_ENDPOINT = 'http://localhost:3900', S3_REGION = 'garage', S3_BUCKET = 'documentos',
  S3_ACCESS_KEY, S3_SECRET_KEY, API_KEY, ADMIN_KEY, ALLOWED_ORIGIN, PORT = 3000,
  MAX_MB = 50, RATE_LIMIT = 120, // peticiones por minuto y por IP
} = process.env;
if (!S3_ACCESS_KEY || !S3_SECRET_KEY || !API_KEY || !ADMIN_KEY) {
  console.error('Faltan variables en .env (ver .env.example)'); process.exit(1);
}
const MAX_BYTES = MAX_MB * 1024 * 1024;

// --- Base de datos con índices ---
const db = new DatabaseSync('docs.db');
db.exec(`
  PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL,
    size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_sha  ON documents(sha256);              -- evita duplicados
  CREATE INDEX IF NOT EXISTS idx_docs_created     ON documents(created_at DESC);     -- listados recientes
  CREATE INDEX IF NOT EXISTS idx_docs_name        ON documents(name COLLATE NOCASE); -- búsqueda por nombre
`);

// --- Cliente S3 mínimo (firma AWS SigV4) ---
const sha = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
async function s3(method, key, body = Buffer.alloc(0), type) {
  const u = new URL(`${S3_ENDPOINT}/${S3_BUCKET}/${key}`);
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amz.slice(0, 8), hash = sha(body);
  const h = { host: u.host, 'x-amz-content-sha256': hash, 'x-amz-date': amz };
  if (type) h['content-type'] = type;
  const names = Object.keys(h).sort();
  const canon = [method, u.pathname, '', names.map((n) => `${n}:${h[n]}\n`).join(''), names.join(';'), hash].join('\n');
  const scope = `${day}/${S3_REGION}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${sha(canon)}`;
  const kSign = hmac(hmac(hmac(hmac('AWS4' + S3_SECRET_KEY, day), S3_REGION), 's3'), 'aws4_request');
  const sig = createHmac('sha256', kSign).update(toSign).digest('hex');
  delete h.host;
  h.authorization = `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  return fetch(u, { method, headers: h, body: method === 'PUT' ? body : undefined });
}

// --- Utilidades ---
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const eq = (a = '', b = '') => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const role = (req) => {
  const k = req.headers['x-api-key'] || '';
  return eq(k, ADMIN_KEY) ? 'admin' : eq(k, API_KEY) ? 'api' : null;
};
async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) {
    if ((n += c.length) > MAX_BYTES) throw { status: 413, msg: `Máximo ${MAX_MB} MB por archivo` };
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// --- Control de tráfico (ventana de 1 minuto por IP) ---
const hits = new Map();
setInterval(() => { const t = Date.now(); for (const [ip, v] of hits) if (v.reset < t) hits.delete(ip); }, 60_000).unref();
function limited(ip) {
  const t = Date.now(); let v = hits.get(ip);
  if (!v || v.reset < t) hits.set(ip, (v = { n: 0, reset: t + 60_000 }));
  return ++v.n > RATE_LIMIT;
}

const adminHtml = readFileSync(new URL('./admin.html', import.meta.url));

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // CORS: solo ALLOWED_ORIGIN (y el propio servidor, para el panel /admin)
    const origin = req.headers.origin;
    if (origin) {
      const ok = [ALLOWED_ORIGIN, `http://${req.headers.host}`, `https://${req.headers.host}`];
      if (!ok.includes(origin)) return json(res, 403, { error: 'Origen no permitido' });
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'x-api-key, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    // Tráfico (si hay proxy inverso, usa x-forwarded-for en lugar de remoteAddress)
    if (limited(req.socket.remoteAddress)) {
      res.setHeader('retry-after', '60');
      return json(res, 429, { error: 'Demasiadas peticiones. Intenta en un minuto.' });
    }

    if (req.method === 'GET' && url.pathname === '/admin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(adminHtml);
    }

    const who = role(req);
    if (!who) return json(res, 401, { error: 'API key inválida' });
    const p = url.pathname.split('/').filter(Boolean); // ['api','documents',id]

    if (p[0] !== 'api') return json(res, 404, { error: 'No encontrado' });

    // POST /api/documents?name=archivo.pdf  (cuerpo = bytes del archivo)
    if (req.method === 'POST' && p[1] === 'documents' && !p[2]) {
      const name = (url.searchParams.get('name') || '').trim().slice(0, 255);
      if (!name) return json(res, 400, { error: 'Falta ?name=' });
      const body = await readBody(req);
      if (!body.length) return json(res, 400, { error: 'Archivo vacío' });
      const hash = sha(body);
      const dup = db.prepare('SELECT id, name FROM documents WHERE sha256 = ?').get(hash);
      if (dup) return json(res, 200, { ...dup, duplicate: true });
      const id = randomUUID();
      const mime = req.headers['content-type'] || 'application/octet-stream';
      const r = await s3('PUT', id, body, mime);
      if (!r.ok) return json(res, 502, { error: 'No se pudo guardar en Garage' });
      db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?)').run(id, name, mime, body.length, hash, Date.now());
      return json(res, 201, { id, name, size: body.length });
    }

    // GET /api/documents?q=prefijo&limit=50&offset=0
    if (req.method === 'GET' && p[1] === 'documents' && !p[2]) {
      const q = (url.searchParams.get('q') || '').replace(/[%_]/g, '');
      const limit = Math.min(+url.searchParams.get('limit') || 50, 200);
      const offset = +url.searchParams.get('offset') || 0;
      const rows = q
        ? db.prepare('SELECT id,name,mime,size,created_at FROM documents WHERE name LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(q + '%', limit, offset)
        : db.prepare('SELECT id,name,mime,size,created_at FROM documents ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
      return json(res, 200, rows);
    }

    // GET /api/documents/:id  → descarga
    if (req.method === 'GET' && p[1] === 'documents' && p[2]) {
      const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(p[2]);
      if (!row) return json(res, 404, { error: 'Documento no existe' });
      const r = await s3('GET', row.id);
      if (!r.ok) return json(res, 502, { error: 'No se pudo leer de Garage' });
      res.writeHead(200, {
        'content-type': row.mime, 'content-length': row.size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      });
      return Readable.fromWeb(r.body).pipe(res);
    }

    // --- Solo administrador ---
    if (who !== 'admin') return json(res, 403, { error: 'Requiere clave de administrador' });

    if (req.method === 'DELETE' && p[1] === 'documents' && p[2]) {
      const r = await s3('DELETE', p[2]);
      if (!r.ok && r.status !== 404) return json(res, 502, { error: 'No se pudo borrar en Garage' });
      db.prepare('DELETE FROM documents WHERE id = ?').run(p[2]);
      return json(res, 200, { deleted: p[2] });
    }

    if (req.method === 'GET' && p[1] === 'admin' && p[2] === 'stats') {
      const s = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(size),0) AS bytes FROM documents').get();
      const d = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE created_at > ?').get(Date.now() - 864e5);
      return json(res, 200, { total: s.total, bytes: s.bytes, last24h: d.n });
    }

    json(res, 404, { error: 'No encontrado' });
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.msg });
    console.error(e); json(res, 500, { error: 'Error interno' });
  }
}).listen(PORT, () => console.log(`Registro documental en http://localhost:${PORT}  (panel: /admin)`));
