import { Injectable } from '@nestjs/common';
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { AUDIT_EVENT_SCHEMA } from '@frontdesk/contracts';
import type { TicketDomainEvent } from '../domain/ticket/audit-events';
import { auditToRow } from '../infrastructure/persistence/ticket-mapper';
import type { Tx } from './unit-of-work';
import { uuidv7 } from '../common/uuid-v7';
import { CommitHooks } from '../observability/commit-hooks';
import { MetricsService } from '../observability/metrics.service';

/** Envelope exactly as the staff audit endpoint returns it (OpenAPI AuditEvent). */
export interface AuditEnvelope {
  id: string;
  ticketId: string;
  actorId: string | null;
  actorType: string;
  action: string;
  createdAt: string;
  correlationId: string;
  reasonCode: string | null;
  details: unknown;
}

export class AuditPayloadError extends Error {
  constructor(readonly action: string) {
    super(`audit payload for ${action} violates the contract`);
    this.name = 'AuditPayloadError';
  }
}

/** Strict action-bound validator compiled from the OpenAPI-generated schema; used at write AND read. */
@Injectable()
export class AuditValidator {
  private readonly validate: ValidateFunction;
  constructor() {
    const ajv = new Ajv({ strict: false, allErrors: false });
    addFormats(ajv);
    ajv.addSchema(AUDIT_EVENT_SCHEMA as object, 'audit');
    this.validate = ajv.compile({ $ref: 'audit#/components/schemas/AuditEvent' });
  }
  /** Fails closed: unknown action, wrong shape or any undeclared (possibly sensitive) field throws. */
  assert(envelope: AuditEnvelope): AuditEnvelope {
    const action = envelope.action;
    if (!this.validate(envelope)) throw new AuditPayloadError(action);
    return envelope;
  }
}

/** Appends ticket audit events inside the caller's transaction; a failure aborts the whole mutation. */
@Injectable()
export class AuditWriter {
  constructor(
    private readonly validator: AuditValidator,
    private readonly hooks: CommitHooks,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * M03: `createdAt` is the RECORDING time — fresh PostgreSQL clock_timestamp() sampled at append — while
   * logical business times (publishedAt, breachedAt, completedAt, ...) stay in `details`. SLA_BREACHED.recordedAt
   * is the same recording time. Appended in the caller's transaction: visible only once it commits.
   */
  async appendTicketEvents(tx: Tx, events: readonly TicketDomainEvent[], correlationId: string, priority?: string): Promise<void> {
    if (!events.length) return;
    const breaches = events.flatMap((e) => (e.action === 'SLA_BREACHED' ? [(e.details as { clock: { kind: string } }).clock.kind] : []));
    if (breaches.length) this.hooks.onCommit(tx, () => breaches.forEach((clock) => this.metrics.breachRecorded(clock, priority ?? 'other')));
    const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
    const now = clock[0]!.now;
    const recordedAt = now.toISOString();
    const rows = events.map((source) => {
      const e = source.action === 'SLA_BREACHED' ? { ...source, details: { ...source.details, recordedAt } } : source;
      const id = uuidv7();
      this.validator.assert({
        id,
        ticketId: e.ticketId,
        actorId: e.actor.type === 'SYSTEM' ? null : e.actor.id,
        actorType: e.actor.type,
        action: e.action,
        createdAt: recordedAt,
        correlationId,
        reasonCode: e.reasonCode,
        details: e.details,
      });
      return auditToRow(e, { id, correlationId, recordedAt: now });
    });
    await tx.auditEvent.createMany({ data: rows });
  }
}
