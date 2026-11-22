import { RateLimiter } from '../../apps/api/src/common/rate-limiter';

class SmallLimiter extends RateLimiter {
  protected override readonly maxKeys = 100;
}

describe('RateLimiter (M01): bounded memory, per-key windows', () => {
  it('a spray of distinct keys never grows beyond the bound, and the counted caller is still limited', () => {
    const l = new SmallLimiter();
    for (let i = 0; i < 5000; i++) l.consume(`ip:${i}`, 10);
    expect(l.size()).toBeLessThanOrEqual(100);
    for (let i = 0; i < 3; i++) l.consume('user:noisy', 3);
    expect(() => l.consume('user:noisy', 3)).toThrow(/Too many/);
    l.onModuleDestroy();
  });
  it('independent keys have independent budgets', () => {
    const l = new RateLimiter();
    for (let i = 0; i < 5; i++) l.consume('api:user:a', 5);
    expect(() => l.consume('api:user:a', 5)).toThrow();
    expect(() => l.consume('api:user:b', 5)).not.toThrow();
    l.onModuleDestroy();
  });
});
