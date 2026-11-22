import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { Errors } from '../common/app-error';
import { hmac, safeEqual, sha256, subkey } from '../auth/crypto';

export interface Position {
  t: number;
  i: string;
}

/** Opaque, signed keyset cursor bound to the actor and the exact filter set (no offset drift, no tampering). */
@Injectable()
export class CursorCodec {
  private readonly key: Buffer;
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = subkey(config.JWT_SECRET, 'cursor');
  }

  encode(scope: unknown, pos: Position): string {
    const payload = Buffer.from(JSON.stringify({ s: sha256(JSON.stringify(scope)), t: pos.t, i: pos.i })).toString('base64url');
    return `${payload}.${hmac(this.key, payload)}`;
  }

  decode(scope: unknown, cursor: string | undefined): Position | null {
    if (cursor === undefined) return null;
    const bad = () => Errors.badRequest('INVALID_CURSOR', 'The pagination cursor is invalid for this query.');
    const [payload, sig] = cursor.split('.');
    if (!payload || !sig || !safeEqual(sig, hmac(this.key, payload))) throw bad();
    try {
      const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { s: string; t: number; i: string };
      if (c.s !== sha256(JSON.stringify(scope)) || !Number.isSafeInteger(c.t) || typeof c.i !== 'string') throw bad();
      return { t: c.t, i: c.i };
    } catch {
      throw bad();
    }
  }
}
