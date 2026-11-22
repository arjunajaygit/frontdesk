import { Global, Module } from '@nestjs/common';
import { parseEnv, AppConfig } from './env';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => parseEnv(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
