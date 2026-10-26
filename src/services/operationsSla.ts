export interface TicketSlaStateEvent {
  status: string;
  actionOwner: string | null;
  occurredAt: string | Date;
}

export type TicketSlaState = 'unconfigured' | 'on_track' | 'at_risk' | 'met' | 'breached';

export interface TicketSlaMetric {
  targetMinutes: number | null;
  elapsedMinutes: number | null;
  stoppedAt: string | null;
  state: TicketSlaState;
}

function paused(event: TicketSlaStateEvent): boolean {
  return event.status === 'awaiting_client' || event.status === 'on_hold' || event.actionOwner === 'client';
}

/** Elapsed wall-clock minutes, excluding intervals in which the client owns the next action. */
export function elapsedTicketMinutes(
  startAt: string | Date,
  endAt: string | Date,
  events: TicketSlaStateEvent[]
): number {
  const start = new Date(startAt).getTime();
  const end = Math.max(start, new Date(endAt).getTime());
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const timeline = events
    .map(event => ({ ...event, at: new Date(event.occurredAt).getTime() }))
    .filter(event => Number.isFinite(event.at) && event.at <= end)
    .sort((a, b) => a.at - b.at);

  let isPaused = false;
  for (const event of timeline) {
    if (event.at > start) break;
    isPaused = paused(event);
  }

  let cursor = start;
  let elapsed = 0;
  for (const event of timeline) {
    if (event.at <= start) continue;
    if (event.at >= end) break;
    if (!isPaused) elapsed += event.at - cursor;
    cursor = event.at;
    isPaused = paused(event);
  }
  if (!isPaused) elapsed += end - cursor;
  return Math.max(0, Math.floor(elapsed / 60_000));
}

export function ticketSlaMetric(input: {
  startAt: string | Date;
  now?: string | Date;
  stoppedAt?: string | Date | null;
  targetMinutes?: number | null;
  events: TicketSlaStateEvent[];
}): TicketSlaMetric {
  const stoppedAt = input.stoppedAt ? new Date(input.stoppedAt).toISOString() : null;
  if (!input.targetMinutes || input.targetMinutes <= 0) {
    return { targetMinutes: null, elapsedMinutes: null, stoppedAt, state: 'unconfigured' };
  }
  const endAt = input.stoppedAt ?? input.now ?? new Date();
  const elapsedMinutes = elapsedTicketMinutes(input.startAt, endAt, input.events);
  const state: TicketSlaState = input.stoppedAt
    ? elapsedMinutes <= input.targetMinutes ? 'met' : 'breached'
    : elapsedMinutes > input.targetMinutes ? 'breached'
      : elapsedMinutes >= input.targetMinutes * 0.8 ? 'at_risk' : 'on_track';
  return { targetMinutes: input.targetMinutes, elapsedMinutes, stoppedAt, state };
}
