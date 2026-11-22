import { uuidv7 } from '../../apps/api/src/common/uuid-v7';

describe('monotonic UUIDv7 audit ids', () => {
  it('are valid v7 UUIDs that sort in emission order, even within one millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7(1_800_000_000_000));
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('never goes backwards when the wall clock steps back', () => {
    const a = uuidv7(1_900_000_000_000);
    const b = uuidv7(1_899_999_999_000);
    expect(b > a).toBe(true);
  });
});
