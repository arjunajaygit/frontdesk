import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Principal } from '../auth/principal';

declare module 'express-serve-static-core' {
  interface Request {
    /** Server-generated request/correlation id (never taken from the client). */
    id: string;
    principal?: Principal;
  }
}

/** Correlation id + no-store/Vary on every API response (success and error). */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Cookie');
  next();
}
