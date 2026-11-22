const IST = 'Asia/Kolkata';

const dateTime = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const dateTimeShort = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const dateTimeYear = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** "Mon, 23 Nov, 14:30 IST" — the business timezone is always labelled. */
export const formatIst = (iso: string | null | undefined): string => (iso ? `${dateTime.format(new Date(iso))} IST` : '—');
/** Compact form for dense lists ("22 Nov, 17:27"); callers expose the IST label via title / screen-reader text. */
export const formatIstShort = (iso: string): string => dateTimeShort.format(new Date(iso));
/** Full precision for audit evidence, including seconds and the year. */
export const formatIstFull = (iso: string): string => `${dateTimeYear.format(new Date(iso))} IST`;
export const utcIso = (iso: string): string => new Date(iso).toISOString();

/** Working-time duration from server-provided milliseconds (never a wall-clock countdown). */
export function formatWorking(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin === 0) return '<1m';
  const days = Math.floor(totalMin / 540); // 9-hour working day
  const hours = Math.floor((totalMin % 540) / 60);
  const min = totalMin % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', min && !days ? `${min}m` : ''].filter(Boolean).join(' ') || '0m';
}

/** Short stable reference derived from the ticket id (the API has no separate human number). */
export const ticketRef = (id: string): string => `FD-${id.slice(0, 8).toUpperCase()}`;

export const priorityLabel = { URGENT: 'Urgent', MEDIUM: 'Medium', LOW: 'Low' } as const;
export const statusLabel = { OPEN: 'Open', IN_PROGRESS: 'In progress', WAITING: 'Waiting on customer', RESOLVED: 'Resolved', CLOSED: 'Closed' } as const;
