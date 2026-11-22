import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { RuntimePrivilegeError, verifyRuntimePrivileges } from './runtime-privileges';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private violations: string[] = ['NOT_VERIFIED'];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  /** Connect, then refuse to start unless the effective DB identity is the restricted runtime role. */
  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.violations = await verifyRuntimePrivileges(this, this.config.DATABASE_RUNTIME_ROLE);
    if (this.violations.length) {
      await this.$disconnect();
      throw new RuntimePrivilegeError(this.violations);
    }
  }

  /** Readiness also reports unsafe privileges (defence in depth; startup already failed closed). */
  runtimeSafe(): boolean {
    return this.violations.length === 0;
  }

  /**
   * Disconnect in the LAST lifecycle phase. Nest runs onModuleDestroy -> beforeApplicationShutdown
   * (scheduler stops and drains in-flight sweep transactions) -> HTTP server close (in-flight requests finish) ->
   * onApplicationShutdown. Disconnecting earlier (onModuleDestroy) cut the database out from under a draining sweep.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
