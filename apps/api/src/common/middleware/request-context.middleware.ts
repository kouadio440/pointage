import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Attribue un identifiant a chaque requete.
 *
 * Il se retrouve dans chaque ligne de journal, dans chaque entree du journal
 * d'audit et dans le message d'erreur affiche a l'utilisateur. Un client qui
 * signale « erreur req_01J8XYZ » permet de retrouver la trace complete
 * immediatement, sans avoir a lui demander l'heure exacte de l'incident.
 *
 * L'identifiant fourni par le client n'est jamais reutilise tel quel : ce serait
 * un vecteur d'injection dans les journaux et de collision volontaire.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    (req as Request & { requestId: string }).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  }
}
