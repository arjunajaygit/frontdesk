import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { ACCESS_TOKEN_TTL_MS } from '@frontdesk/contracts';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { Errors } from '../common/app-error';
import { keyBytes } from './crypto';

const ISSUER = 'frontdesk';
const AUDIENCE = 'frontdesk-api';

/** Short-lived HS256 access JWT; algorithm allow-list, iss/aud/exp/sub/sid/typ all verified. */
@Injectable()
export class AccessTokenService {
  private readonly key: Buffer;
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = keyBytes(config.JWT_SECRET);
  }

  sign(userId: string, sessionId: string): string {
    return jwt.sign({ sid: sessionId, typ: 'access' }, this.key, {
      algorithm: 'HS256',
      subject: userId,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      jwtid: randomUUID(),
    });
  }

  verify(token: string): { userId: string; sessionId: string } {
    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(token, this.key, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    } catch {
      throw Errors.unauthenticated();
    }
    // jsonwebtoken only checks exp when present: require every mandatory claim explicitly, so a token without an expiry is never accepted.
    const maxLifetime = Math.floor(ACCESS_TOKEN_TTL_MS / 1000) + 5;
    if (
      typeof payload !== 'object' ||
      payload.typ !== 'access' ||
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      typeof payload.sid !== 'string' ||
      payload.sid.length === 0 ||
      !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(payload.iat) ||
      payload.exp! <= payload.iat! ||
      payload.exp! - payload.iat! > maxLifetime ||
      payload.iss !== ISSUER ||
      payload.aud !== AUDIENCE
    ) {
      throw Errors.unauthenticated();
    }
    return { userId: payload.sub, sessionId: payload.sid };
  }
}
