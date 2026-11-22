import { ArrowDown, ArrowUp, ChevronsUp, CircleDot, CircleCheck, CircleSlash, Hourglass, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { priorityLabel, statusLabel } from '@/lib/format';
import type { Priority, Status } from '@/lib/types';

const PRI = { URGENT: { tone: 'bad', icon: ChevronsUp }, MEDIUM: { tone: 'info', icon: ArrowUp }, LOW: { tone: 'neutral', icon: ArrowDown } } as const;
export const PriorityBadge = ({ priority }: { priority: Priority }) => {
  const { tone, icon: Icon } = PRI[priority];
  return (
    <Badge tone={tone}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {priorityLabel[priority]}
    </Badge>
  );
};

const ST = { OPEN: { tone: 'info', icon: CircleDot }, IN_PROGRESS: { tone: 'brand', icon: UserRound }, WAITING: { tone: 'warn', icon: Hourglass }, RESOLVED: { tone: 'ok', icon: CircleCheck }, CLOSED: { tone: 'neutral', icon: CircleSlash } } as const;
export const StatusBadge = ({ status }: { status: Status }) => {
  const { tone, icon: Icon } = ST[status];
  return (
    <Badge tone={tone}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {statusLabel[status]}
    </Badge>
  );
};
