import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The committed Supabase root CA is what the deployed runtime and the hosted verification scripts trust for the
 * database pooler. Pin it so a swapped or corrupted certificate fails CI. Fingerprint cross-checked on 2026-11-22:
 * downloaded over verified HTTPS from Supabase AND equal to the root served in the pooler's own TLS chain.
 */
describe('Supabase root CA (database TLS verification)', () => {
  const pem = readFileSync('infrastructure/deploy/supabase/supabase-prod-ca-2021.crt');
  const cert = new X509Certificate(pem);
  it('is the pinned Supabase Root 2021 CA', () => {
    expect(createHash('sha256').update(cert.raw).digest('hex')).toBe(
      '807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa',
    );
    expect(cert.subject).toContain('CN=Supabase Root 2021 CA');
    expect(cert.ca).toBe(true);
  });
  it('is valid for the review period', () => {
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.parse('2027-01-01'));
  });
});
