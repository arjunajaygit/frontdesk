/** Domain rejection. `kind` lets the HTTP layer (M3) map to 400/403/404/409 without domain knowledge of HTTP. */
export type DomainErrorKind = 'VALIDATION' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT';

export type DomainErrorCode =
  | 'FORBIDDEN_ACTOR'
  | 'NOT_ASSIGNEE'
  | 'NOT_OWNER'
  | 'ALREADY_CLAIMED'
  | 'INVALID_STATE'
  | 'USE_REPLY'
  | 'MESSAGE_REQUIRED'
  | 'INVALID_INPUT';

const KIND: Record<DomainErrorCode, DomainErrorKind> = {
  FORBIDDEN_ACTOR: 'FORBIDDEN',
  NOT_ASSIGNEE: 'FORBIDDEN',
  NOT_OWNER: 'NOT_FOUND',
  ALREADY_CLAIMED: 'CONFLICT',
  INVALID_STATE: 'CONFLICT',
  USE_REPLY: 'CONFLICT',
  MESSAGE_REQUIRED: 'VALIDATION',
  INVALID_INPUT: 'VALIDATION',
};

export class DomainError extends Error {
  readonly kind: DomainErrorKind;
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
    this.kind = KIND[code];
  }
}
