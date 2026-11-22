/** Safe, client-facing error. Messages must never contain secrets, private content or assignee data. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Only ever set by the authorised staff claim-conflict path (StaffClaimConflict). */
    readonly assignedAgentDisplayName?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (code: string, message: string) => new AppError(400, code, message),
  unauthenticated: (message = 'Authentication required.') => new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (code = 'FORBIDDEN', message = 'You are not allowed to perform this action.') => new AppError(403, code, message),
  notFound: (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  tooMany: () => new AppError(429, 'RATE_LIMITED', 'Too many requests. Please retry later.'),
  unavailable: (code = 'UNAVAILABLE', message = 'Service temporarily unavailable. Please retry.') => new AppError(503, code, message),
};
