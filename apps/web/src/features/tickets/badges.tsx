import { ArrowDown, ArrowUp, ChevronsUp, CircleCheck, CircleDashed, CircleSlash, Hourglass, UserRound } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { priorityLabel, statusLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Priority, Status } from '@/lib/types';

const PRI = {
  URGENT: { tone: 'bad', icon: ChevronsUp, mark: 'text-danger' },
  MEDIUM: { tone: 'info', icon: ArrowUp, mark: 'text-info' },
  LOW: { tone: 'neutral', icon: ArrowDown, mark: 'text-ink-3' },
} as const;

export const PriorityBadge = ({ priority }: { priority: Priority }) => {
  const { tone, icon: Icon } = PRI[priority];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {priorityLabel[priority]}
    </Badge>
  );
};

/** Quiet priority for dense rows: icon + word, no chip. Urgent stays red so it is found at a glance. */
export const PriorityMark = ({ priority }: { priority: Priority }) => {
  const { icon: Icon, mark } = PRI[priority];
  return (
    <span className={cn('inline-flex items-center gap-1 text-meta font-medium', priority === 'URGENT' ? 'text-danger-ink' : 'text-ink-2')}>
      <Icon className={cn('h-3.5 w-3.5', mark)} aria-hidden="true" />
      {priorityLabel[priority]}
    </span>
  );
};

const ST: Record<Status, { tone: BadgeTone; icon: typeof CircleDashed }> = {
  OPEN: { tone: 'info', icon: CircleDashed },
  IN_PROGRESS: { tone: 'brand', icon: UserRound },
  WAITING: { tone: 'warn', icon: Hourglass },
  RESOLVED: { tone: 'ok', icon: CircleCheck },
  CLOSED: { tone: 'neutral', icon: CircleSlash },
};
export const statusTone = (s: Status): BadgeTone => ST[s].tone;

export const StatusBadge = ({ status }: { status: Status }) => {
  const { tone, icon: Icon } = ST[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {statusLabel[status]}
    </Badge>
  );
};
