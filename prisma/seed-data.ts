/** Static synthetic identities and holidays. Fictional data only; no real people or organisations. */
export const PRIVATE_NOTE_MARKER = 'PRIVATE-NOTE-MARKER-FD010-DO-NOT-LEAK';

export const AGENTS = [
  { key: 'meera', email: 'meera.iyer@arvo.example', displayName: 'Meera Iyer', role: 'LEAD' },
  { key: 'arjun', email: 'arjun.nair@arvo.example', displayName: 'Arjun Nair', role: 'AGENT' },
  { key: 'priya', email: 'priya.sharma@arvo.example', displayName: 'Priya Sharma', role: 'AGENT' },
  { key: 'rohan', email: 'rohan.mehta@arvo.example', displayName: 'Rohan Mehta', role: 'AGENT' },
  { key: 'kavya', email: 'kavya.reddy@arvo.example', displayName: 'Kavya Reddy', role: 'AGENT' },
  { key: 'vikram', email: 'vikram.singh@arvo.example', displayName: 'Vikram Singh', role: 'AGENT' },
  { key: 'ananya', email: 'ananya.das@arvo.example', displayName: 'Ananya Das', role: 'AGENT' },
  { key: 'imran', email: 'imran.khan@arvo.example', displayName: 'Imran Khan', role: 'AGENT' },
  { key: 'sneha', email: 'sneha.patil@arvo.example', displayName: 'Sneha Patil', role: 'AGENT' },
] as const;

export const CUSTOMERS = [
  {
    key: 'aarav',
    email: 'aarav.menon@customer.example',
    displayName: 'Aarav Menon (Menon Logistics)',
    role: 'CUSTOMER',
  },
  {
    key: 'diya',
    email: 'diya.kapoor@customer.example',
    displayName: 'Diya Kapoor (Kapoor Textiles)',
    role: 'CUSTOMER',
  },
  {
    key: 'sana',
    email: 'sana.qureshi@customer.example',
    displayName: 'Sana Qureshi (Qureshi Foods)',
    role: 'CUSTOMER',
  },
] as const;

/** Configurable, ILLUSTRATIVE demo holidays (YYYY-MM-DD) — not asserted to be official calendars. */
export const HOLIDAYS = [
  { day: '2026-10-02', name: 'Illustrative holiday: national observance (demo)' },
  { day: '2026-11-09', name: 'Illustrative festival holiday (demo)' },
  { day: '2026-12-25', name: 'Illustrative year-end holiday (demo)' },
] as const;
