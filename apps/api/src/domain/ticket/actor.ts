/** Actor derived from the verified session, never from request bodies. SYSTEM = scheduler/rules. */
export type StaffRole = 'AGENT' | 'LEAD' | 'ADMIN';
export type StaffActor = { readonly type: StaffRole; readonly id: string };
export type CustomerActor = { readonly type: 'CUSTOMER'; readonly id: string };
export type SystemActor = { readonly type: 'SYSTEM' };
export type Actor = StaffActor | CustomerActor | SystemActor;

export const SYSTEM: SystemActor = Object.freeze({ type: 'SYSTEM' });

export const isStaff = (a: Actor): a is StaffActor => a.type === 'AGENT' || a.type === 'LEAD' || a.type === 'ADMIN';
export const isCustomer = (a: Actor): a is CustomerActor => a.type === 'CUSTOMER';
export const actorId = (a: Actor): string | null => (a.type === 'SYSTEM' ? null : a.id);
