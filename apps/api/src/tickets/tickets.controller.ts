import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Errors } from '../common/app-error';
import { Schemas, parse, uuid } from '../common/validation';
import { CustomerOnly, StaffOnly } from '../auth/guards';
import type { Principal } from '../auth/principal';
import { CommandContext, CommandOutcome, TicketCommandService } from './ticket-command.service';
import { TicketQueryService } from './ticket-query.service';

const principal = (req: Request): Principal => {
  if (!req.principal) throw Errors.unauthenticated();
  return req.principal;
};
const id = (raw: string) => parse(uuid, raw, 'ticket id');
const ctx = (req: Request, operation: string): CommandContext => ({
  principal: principal(req),
  operation,
  idempotencyKey: parse(Schemas.idempotencyKey, req.header('idempotency-key'), 'Idempotency-Key header'),
  requestId: req.id,
});
const send = (res: Response, out: CommandOutcome) => {
  res.status(out.status);
  return out.body;
};

/** Staff-only directory used by the intake form: ids and display names only (no emails). */
@StaffOnly()
@Controller('customers')
export class CustomersController {
  constructor(private readonly queries: TicketQueryService) {}

  @Get()
  list() {
    return this.queries.customers();
  }
}

/** Staff API (AGENT/LEAD/ADMIN). Thin: parse -> application service -> DTO. */
@StaffOnly()
@Controller('tickets')
export class StaffTicketsController {
  constructor(
    private readonly commands: TicketCommandService,
    private readonly queries: TicketQueryService,
  ) {}

  @Get()
  list(@Req() req: Request, @Query() query: unknown) {
    return this.queries.staffList(principal(req), parse(Schemas.staffList, query, 'query'));
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(Schemas.staffIntake, body, 'body');
    return send(res, await this.commands.staffIntake(ctx(req, 'POST /tickets'), input));
  }

  @Get(':id')
  detail(@Req() req: Request, @Param('id') raw: string) {
    return this.queries.staffDetail(principal(req), id(raw));
  }

  /** Full timeline, newest page first; follow nextCursor for older messages (H03). */
  @Get(':id/messages')
  messages(@Req() req: Request, @Param('id') raw: string, @Query() query: unknown) {
    return this.queries.staffMessages(principal(req), id(raw), parse(Schemas.timeline, query, 'query'));
  }

  @Post(':id/claim')
  async claim(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    parse(Schemas.empty, body, 'body');
    return send(res, await this.commands.claim(ctx(req, 'POST /tickets/{id}/claim'), id(raw)));
  }

  @Post(':id/replies')
  async reply(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(Schemas.message, body, 'body');
    return send(res, await this.commands.reply(ctx(req, 'POST /tickets/{id}/replies'), id(raw), input.body));
  }

  @Post(':id/notes')
  async note(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(Schemas.message, body, 'body');
    return send(res, await this.commands.note(ctx(req, 'POST /tickets/{id}/notes'), id(raw), input.body));
  }

  @Post(':id/wait')
  async wait(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(Schemas.message, body, 'body');
    return send(res, await this.commands.requestInformation(ctx(req, 'POST /tickets/{id}/wait'), id(raw), input.body));
  }

  @Post(':id/resolve')
  async resolve(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(Schemas.resolve, body ?? {}, 'body');
    return send(res, await this.commands.resolve(ctx(req, 'POST /tickets/{id}/resolve'), id(raw), input.body));
  }

  /** Compatibility stub: staff can never reopen on a customer's behalf (no impersonation). */
  @Post(':id/reopen')
  reopen(@Param('id') raw: string): never {
    id(raw);
    throw Errors.forbidden('STAFF_REOPEN_FORBIDDEN', 'Only the owning customer can reopen a ticket.');
  }

  @Patch(':id/priority')
  async priority(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(Schemas.priority, body, 'body');
    return send(res, await this.commands.changePriority(ctx(req, 'PATCH /tickets/{id}/priority'), id(raw), input.priority));
  }

  @Get(':id/audit')
  audit(@Req() req: Request, @Param('id') raw: string, @Query() query: unknown) {
    return this.queries.audit(principal(req), id(raw), parse(Schemas.page, query, 'query'));
  }
}

/** Customer API: every path is scoped to the authenticated customer's own tickets (others => 404). */
@CustomerOnly()
@Controller('customer/tickets')
export class CustomerTicketsController {
  constructor(
    private readonly commands: TicketCommandService,
    private readonly queries: TicketQueryService,
  ) {}

  @Get()
  list(@Req() req: Request, @Query() query: unknown) {
    return this.queries.customerList(principal(req), parse(Schemas.page, query, 'query'));
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(Schemas.customerIntake, body, 'body');
    return send(res, await this.commands.customerIntake(ctx(req, 'POST /customer/tickets'), input));
  }

  @Get(':id')
  detail(@Req() req: Request, @Param('id') raw: string) {
    return this.queries.customerDetail(principal(req), id(raw));
  }

  @Get(':id/messages')
  messages(@Req() req: Request, @Param('id') raw: string, @Query() query: unknown) {
    return this.queries.customerMessages(principal(req), id(raw), parse(Schemas.timeline, query, 'query'));
  }

  @Get(':id/export')
  async export(@Req() req: Request, @Param('id') raw: string, @Query() query: unknown, @Res() res: Response) {
    const { format } = parse(Schemas.exportQuery, query, 'query');
    const out = await this.queries.customerExport(principal(req), id(raw), format);
    res.status(200).setHeader('Content-Type', out.contentType).setHeader('Content-Disposition', `attachment; filename="${out.filename}"`).send(out.payload);
  }

  @Post(':id/replies')
  async reply(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(Schemas.message, body, 'body');
    return send(res, await this.commands.customerReply(ctx(req, 'POST /customer/tickets/{id}/replies'), id(raw), input.body));
  }

  @Post(':id/reopen')
  async reopen(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(Schemas.message, body, 'body');
    return send(res, await this.commands.customerReopen(ctx(req, 'POST /customer/tickets/{id}/reopen'), id(raw), input.body));
  }
}
