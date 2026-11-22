import { envFile, roleUrl } from '../../helpers/db';

/** Isolated e2e stack: its own database, API port and web port (never the default dev stack or old dev DB). */
export const E2E_DB = 'frontdesk_e2e';
export const API_PORT = 3100;
export const WEB_PORT = 5273;
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
/** Scratch-only password for the throw-away e2e database. Never used elsewhere. */
export const E2E_PASSWORD = 'e2e-only-Passw0rd-not-a-secret';

export const USERS = {
  lead: 'meera.iyer@arvo.example',
  agent1: 'arjun.nair@arvo.example',
  agent2: 'priya.sharma@arvo.example',
  imran: 'imran.khan@arvo.example', // assignee of seeded FD-010
  customer1: 'aarav.menon@customer.example',
  customer2: 'diya.kapoor@customer.example',
} as const;

export function apiEnv(): Record<string, string> {
  return {
    ...envFile(),
    DATABASE_URL: roleUrl('app', E2E_DB),
    NODE_ENV: 'test',
    PORT: String(API_PORT),
    LOG_LEVEL: 'silent',
    PUBLIC_ORIGIN: WEB_ORIGIN,
    SWEEP_SCHEDULER_ENABLED: 'false',
    LOGIN_RATE_LIMIT_PER_MIN: '1000',
    API_RATE_LIMIT_PER_MIN: '100000',
    API_IP_RATE_LIMIT_PER_MIN: '1000000',
    ANON_RATE_LIMIT_PER_MIN: '100000',
    SWEEP_RATE_LIMIT_PER_MIN: '1000',
  };
}
