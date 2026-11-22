import type { Role } from '@frontdesk/contracts';
import type { Actor } from '../domain/ticket/actor';

/** Identity derived exclusively from a verified access token + live DB session. */
export interface Principal {
  readonly userId: string;
  readonly role: Role;
  readonly displayName: string;
  readonly sessionId: string;
}

export const toActor = (p: Principal): Actor =>
  p.role === 'CUSTOMER' ? { type: 'CUSTOMER', id: p.userId } : { type: p.role, id: p.userId };

export const toViewer = (p: { userId: string; displayName: string; role: Role }) => ({
  id: p.userId,
  displayName: p.displayName,
  role: p.role,
});
