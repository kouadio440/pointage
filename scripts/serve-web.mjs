#!/usr/bin/env node
/**
 * Serveur statique pour le site vitrine (apps/web).
 *
 * Volontairement sans dependance : le site vitrine n'a pas de build, pas de
 * package.json et ne doit surtout pas en gagner un. Ce script existe pour le
 * servir en local exactement comme un hebergeur statique le ferait.
 *
 * Usage : node scripts/serve-web.mjs [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
const PORT = Number(process.argv[2] ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Anti-traversee de repertoire : on resout puis on verifie que le chemin
    // final reste sous ROOT. Un serveur de developpement reste un serveur.
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 - Acces refuse');
      return;
    }

    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - Fichier introuvable');
  }
});

server.listen(PORT, () => {
  console.log(`Site vitrine servi sur http://localhost:${PORT}`);
  console.log(`Racine : ${ROOT}`);
});
