import SwaggerParser from '@apidevtools/swagger-parser';
import { Json, SPEC_PATH, loadSpec, makeValidator, reachableProps } from '../helpers/openapi';

const spec = loadSpec();
const validator = makeValidator(spec);
const U = '8b8b8b8b-1111-4111-8111-111111111111';
const T = '2026-11-20T12:30:00.000Z';

const clock = {
  id: U,
  kind: 'RESPONSE',
  cycle: 0,
  state: 'RUNNING',
  cycleStartedAt: T,
  budgetMs: 7200000,
  consumedMs: 0,
  remainingMs: 7200000,
  deadlineAt: T,
  completedAt: null,
  cancelledAt: null,
  currentLate: false,
  firstBreachedAt: null,
  breachDetectedNotRecorded: false,
  asOf: T,
  breachSequence: 0,
  policyRevision: 0,
};
const base = {
  id: U,
  subject: 'Synthetic fixture',
  status: 'OPEN',
  priority: 'MEDIUM',
  requestedPriority: null,
  customerId: U,
  assigneeId: null,
  assigneeDisplayName: null,
  createdAt: T,
  updatedAt: T,
  parentTicketId: null,
  version: 0,
  resolutionCycle: 0,
  waitingCloseDueAt: null,
  reopenUntil: null,
  closeReason: null,
  clocks: [clock],
};
const ok = (name: string, data: unknown) => {
  const fn = validator(name);
  const valid = fn(data);
  if (!valid) throw new Error(`${name} rejected valid fixture: ${JSON.stringify(fn.errors)}`);
};
const bad = (name: string, data: unknown) => expect(validator(name)(data)).toBe(false);

describe('OpenAPI 3.0 conformance (OpenAPI-aware validator)', () => {
  it('validates against the OpenAPI 3.0 meta-schema and resolves every $ref', async () => {
    const api = await SwaggerParser.validate(SPEC_PATH);
    expect((api as Json).openapi).toMatch(/^3\.0\./);
    expect(Object.keys((api as Json).paths).length).toBe(Object.keys(spec.paths).length);
  });

  it.each(['StaffTicketSummary', 'StaffTicket'])(
    '%s: intake, active and closed fixtures conform; null enums valid',
    (name) => {
      const data =
        name === 'StaffTicket' ? { ...base, messages: [], olderMessagesCursor: null } : base;
      ok(name, data); // intake: OPEN, unassigned, requestedPriority null, closeReason null
      ok(name, {
        ...data,
        status: 'IN_PROGRESS',
        assigneeId: U,
        assigneeDisplayName: 'Synthetic Agent',
        requestedPriority: 'URGENT',
      });
      ok(name, {
        ...data,
        status: 'CLOSED',
        closeReason: 'AUTO_CLOSED_NO_REPLY',
        assigneeId: U,
        assigneeDisplayName: 'Synthetic Agent',
        clocks: [{ ...clock, state: 'CANCELLED', deadlineAt: null, cancelledAt: T }],
      });
      bad(name, { ...data, requestedPriority: 'INVALID' });
      bad(name, { ...data, closeReason: 'INVALID' });
    },
  );

  it('nullable enums requestedPriority and closeReason list null explicitly (OpenAPI 3.0.3 semantics)', () => {
    for (const name of ['StaffTicketSummary', 'StaffTicket']) {
      const props = spec.components.schemas[name].properties;
      for (const field of ['requestedPriority', 'closeReason']) {
        expect({ name, field, nullable: props[field].nullable }).toEqual({
          name,
          field,
          nullable: true,
        });
        expect({ name, field, enum: props[field].enum.includes(null) }).toEqual({
          name,
          field,
          enum: true,
        });
      }
    }
  });

  it('customer schemas exclude private information', () => {
    const publicTicket = {
      id: U,
      subject: 's',
      status: 'OPEN',
      createdAt: T,
      parentTicketId: null,
      messages: [
        { id: U, body: 'hello', authorDisplayName: 'Agent', authorType: 'STAFF', createdAt: T },
      ],
      olderMessagesCursor: null,
    };
    ok('PublicTicket', publicTicket);
    ok('PublicTicketSummary', {
      id: U,
      subject: 's',
      status: 'OPEN',
      createdAt: T,
      parentTicketId: null,
    });
    bad('PublicTicket', { ...publicTicket, assigneeId: U });
    bad('PublicTicket', { ...publicTicket, internalNotes: ['x'] });
    bad('PublicTicket', {
      ...publicTicket,
      messages: [{ ...publicTicket.messages[0], visibility: 'PRIVATE' }],
    });
    bad('PublicTicket', {
      ...publicTicket,
      messages: [{ ...publicTicket.messages[0], kind: 'NOTE' }],
    });
    bad('PublicTicket', {
      ...publicTicket,
      messages: [{ ...publicTicket.messages[0], authorType: 'NOTE' }],
    });
    const forbidden = [
      'assigneeId',
      'assigneeDisplayName',
      'assignedAgentDisplayName',
      'requestedPriority',
      'visibility',
      'kind',
      'clocks',
      'details',
      'correlationId',
      'author',
    ];
    for (const [path, ops] of Object.entries<Json>(spec.paths)) {
      if (!path.startsWith('/customer/')) continue;
      for (const op of Object.values<Json>(ops)) {
        const responses = Object.values<Json>(op.responses ?? {})
          .map((r) => r.content?.['application/json']?.schema)
          .filter(Boolean);
        const props = reachableProps(spec, responses);
        for (const f of forbidden)
          expect({ path, leaked: props.has(f) ? f : null }).toEqual({ path, leaked: null });
      }
    }
  });

  it('generic Error excludes assignee; StaffClaimConflict is scoped to the staff claim 409 only', () => {
    const error = { code: 'CLAIM_CONFLICT', message: 'Conflict', requestId: 'fixture' };
    ok('Error', error);
    bad('Error', { ...error, assignedAgentDisplayName: 'Synthetic Agent' });
    ok('StaffClaimConflict', { ...error, assignedAgentDisplayName: 'Synthetic Agent' });
    bad('StaffClaimConflict', { ...error, assigneeId: U });
    const users: string[] = [];
    for (const [path, ops] of Object.entries<Json>(spec.paths)) {
      for (const [method, op] of Object.entries<Json>(ops)) {
        if (JSON.stringify(op).includes('StaffClaimConflict'))
          users.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(users).toEqual(['POST /tickets/{id}/claim']);
    expect(
      spec.paths['/tickets/{id}/claim'].post.responses['409'].content['application/json'].schema
        .$ref,
    ).toMatch(/StaffClaimConflict$/);
  });

  describe('audit union', () => {
    const actions = [
      'TICKET_CREATED',
      'TICKET_CLAIMED',
      'TICKET_REASSIGNED',
      'MESSAGE_PUBLISHED',
      'INTERNAL_NOTE_ADDED',
      'PRIORITY_CHANGED',
      'SLA_PAUSED',
      'SLA_RESUMED',
      'SLA_BREACHED',
      'SLA_COMPLETED',
      'SLA_CANCELLED',
      'TICKET_WAITING',
      'TICKET_RESUMED',
      'TICKET_RESOLVED',
      'TICKET_CLOSED',
      'TICKET_REOPENED',
      'LINKED_TICKET_CREATED',
    ];

    it('has exactly the 17 contract actions, each strict at envelope and details level', () => {
      const members: Json[] = spec.components.schemas.AuditEvent.oneOf.map((r: Json) =>
        r.$ref
          .slice(2)
          .split('/')
          .reduce((a: Json, k: string) => a[k], spec),
      );
      const seen = members.map((m) => m.properties.action.enum[0]).sort();
      expect(seen).toEqual([...actions].sort());
      for (const m of members) {
        expect(m.additionalProperties).toBe(false);
        expect(m.properties.details.additionalProperties).toBe(false);
        expect(m.required).toEqual(
          expect.arrayContaining([
            'correlationId',
            'reasonCode',
            'actorType',
            'createdAt',
            'details',
          ]),
        );
      }
    });

    const event = {
      id: U,
      ticketId: U,
      actorId: U,
      actorType: 'AGENT',
      action: 'MESSAGE_PUBLISHED',
      createdAt: T,
      correlationId: 'fixture',
      reasonCode: null,
      details: {
        beforeVersion: 0,
        afterVersion: 1,
        messageId: U,
        messageKind: 'REPLY',
        publishedAt: T,
      },
    };

    it('accepts a valid event and rejects undeclared, mismatched and unknown payloads', () => {
      ok('AuditEvent', event);
      bad('AuditEvent', { ...event, action: 'PRIORITY_CHANGED' });
      bad('AuditEvent', { ...event, action: 'UNKNOWN' });
      for (const key of [
        'body',
        'email',
        'passwordHash',
        'sessionId',
        'leaseToken',
        'cookie',
        'rawJson',
      ]) {
        bad('AuditEvent', { ...event, details: { ...event.details, [key]: 'secret' } });
      }
      bad('AuditEvent', { ...event, messageBody: 'secret' });
      bad('AuditEvent', { ...event, details: { ...event.details, messageKind: 'NOTE' } }); // notes use INTERNAL_NOTE_ADDED
    });
  });
});
