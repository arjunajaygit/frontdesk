import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { parseEnv } from './config/env';
import { configureApp } from './configure-app';
import { ConfigValidationError } from './config/env';
import { errorMeta } from './common/error-meta';
import { RuntimePrivilegeError } from './prisma/runtime-privileges';

async function bootstrap(): Promise<void> {
  // Fail fast before any connection is opened; messages never contain secret values.
  const config = parseEnv(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));
  configureApp(app, config);
  await app.listen(config.PORT);
  app.get(Logger).log({ commit: process.env.APP_COMMIT ?? 'unknown', env: config.NODE_ENV, port: config.PORT }, 'frontdesk started');
}

bootstrap().catch((err: unknown) => {
  // Only our own controlled messages are printed; anything else is reduced to classified metadata (M05).
  const safe = err instanceof ConfigValidationError || err instanceof RuntimePrivilegeError;
  console.error(safe ? (err as Error).message : `startup failed: ${JSON.stringify(errorMeta(err))}`);
  process.exit(1);
});
