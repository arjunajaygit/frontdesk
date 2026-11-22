import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * RFC 9562 UUIDv7 with a monotonic 12-bit sequence: ids generated in this process sort (as lowercase text)
 * in emission order, so events of one mutation that share a millisecond list in the order they were emitted.
 * Ordering across processes is NOT causal evidence (AUDIT_PAYLOAD_CONTRACT): reconstruct by versions.
 */
export function uuidv7(now: number = Date.now()): string {
  let ms = Math.max(now, lastMs);
  if (ms === lastMs) {
    seq++;
    if (seq > 0xfff) {
      ms = lastMs + 1;
      seq = 0;
    }
  } else {
    seq = randomBytes(2).readUInt16BE(0) & 0x3ff; // random start, headroom for increments
  }
  lastMs = ms;
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
