import { Global, Module } from '@nestjs/common';
import { CommitHooks } from './commit-hooks';
import { MetricsServer } from './metrics.server';
import { MetricsService } from './metrics.service';

@Global()
@Module({ providers: [CommitHooks, MetricsService, MetricsServer], exports: [CommitHooks, MetricsService] })
export class ObservabilityModule {}
