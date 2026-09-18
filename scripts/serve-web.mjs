#!/usr/bin/env node
/**
 * Serveur statique pour le site vitrine (apps/web).
 *
 * Volontairement sans dependance : le site vitrine n'a pas de build, pas de
 * package.json et ne doit surtout pas en gagner un. Ce script existe pour le
 * servir en local exactement comme un hebergeur statique le ferait.
 *
 * Les routes serveur de api/ (facturation) sont executees comme sur Vercel :
 * chaque fichier api/<chemin>.mjs exporte une fonction par methode HTTP
 * (GET, POST...) qui recoit une Request et renvoie une Response. Leurs
 * variables d'environnement se chargent avec l'option native de Node :
 *
 * Usage : node scripts/serve-web.mjs [port]
 *         node --env-file=.env scripts/serve-web.mjs [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
const API = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'api');
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
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function lireCorps(req) {
  return new Promise((ok, echec) => {
    const morceaux = [];
    req.on('data', (m) => morceaux.push(m));
    req.on('end', () => ok(Buffer.concat(morceaux)));
    req.on('error', echec);
  });
}

async function servirApi(req, res, url) {
  const relatif = url.pathname.slice('/api/'.length);
  // Meme regle que Vercel : un segment commencant par « _ » ou « . » n'est
  // jamais une route.
  if (!/^[a-z0-9/_-]+$/i.test(relatif) || relatif.split('/').some((seg) => !seg || /^[_.]/.test(seg))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - Route inconnue');
    return;
  }
  const fichier = join(API, `${relatif}.mjs`);
  try {
    if (!(await stat(fichier)).isFile()) throw new Error('absent');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - Route inconnue');
    return;
  }

  const module = await import(pathToFileURL(fichier).href);
  const gestionnaire = module[req.method];
  if (typeof gestionnaire !== 'function') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 - Methode non autorisee');
    return;
  }

  const entetes = new Headers();
  for (const [nom, valeur] of Object.entries(req.headers)) {
    if (typeof valeur === 'string') entetes.set(nom, valeur);
  }
  const corps = ['GET', 'HEAD'].includes(req.method) ? undefined : await lireCorps(req);
  const reponse = await gestionnaire(new Request(url.href, { method: req.method, headers: entetes, body: corps }));
  const contenu = Buffer.from(await reponse.arrayBuffer());
  res.writeHead(reponse.status, Object.fromEntries(reponse.headers));
  res.end(contenu);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      await servirApi(req, res, url);
      return;
    }
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
      'Cache-Control': 'no-cache',
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
