import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '../domain/shared/domain-error';
import { AppError } from './app-error';
import { errorMeta } from './error-meta';

const KIND_STATUS = { VALIDATION: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409 } as const;
const DOMAIN_MESSAGE: Record<string, string> = {
  NOT_OWNER: 'Not found.',
  NOT_ASSIGNEE: 'Only the assigned staff member can do this.',
  FORBIDDEN_ACTOR: 'You are not allowed to perform this action.',
};

/**
 * Safe error envelope {code, message, requestId}. Only the authorised staff claim conflict may add
 * assignedAgentDisplayName. No stack traces, SQL or internal identifiers ever leave the process.
 */
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  constructor(private readonly log: { error: (obj: Record<string, unknown>, msg: string) => void }) {}

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const { status, body } = this.toEnvelope(err, req.id ?? 'unknown');
    if (status >= 500) {
      this.log.error({ requestId: req.id, ...errorMeta(err) }, 'request failed');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json(body);
  }

  toEnvelope(err: unknown, requestId: string): { status: number; body: Record<string, string> } {
    if (err instanceof AppError) {
      const body: Record<string, string> = { code: err.code, message: err.message, requestId };
      if (err.code === 'CLAIM_CONFLICT' && err.assignedAgentDisplayName) body.assignedAgentDisplayName = err.assignedAgentDisplayName;
      return { status: err.status, body };
    }
    if (err instanceof DomainError) {
      return { status: KIND_STATUS[err.kind], body: { code: err.code, message: DOMAIN_MESSAGE[err.code] ?? err.message, requestId } };
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const code = status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
      return { status, body: { code, message: status === 404 ? 'Not found.' : 'Request could not be processed.', requestId } };
    }
    return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId } };
  }
}
