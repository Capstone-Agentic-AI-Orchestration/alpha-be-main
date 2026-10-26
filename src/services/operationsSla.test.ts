import { describe, expect, it } from 'vitest';
import { elapsedTicketMinutes, ticketSlaMetric } from './operationsSla.js';

const at = (minutes: number) => new Date(Date.parse('2026-10-26T00:00:00Z') + minutes * 60_000).toISOString();

describe('ticket SLA clocks', () => {
  it('stays unconfigured until a priority policy supplies a target', () => {
    expect(ticketSlaMetric({ startAt: at(0), now: at(20), events: [] })).toMatchObject({
      targetMinutes: null, elapsedMinutes: null, state: 'unconfigured'
    });
  });

  it('stops response time at the first public team reply', () => {
    const metric = ticketSlaMetric({ startAt: at(0), stoppedAt: at(24), targetMinutes: 30, events: [] });
    expect(metric).toMatchObject({ elapsedMinutes: 24, stoppedAt: at(24), state: 'met' });
  });

  it('pauses around the clock while waiting for the client and resumes on the next team-owned state', () => {
    const events = [
      { status: 'awaiting_client', actionOwner: 'client', occurredAt: at(10) },
      { status: 'in_progress', actionOwner: 'pm', occurredAt: at(40) },
      { status: 'on_hold', actionOwner: 'pm', occurredAt: at(50) },
      { status: 'in_progress', actionOwner: 'pm', occurredAt: at(70) }
    ];
    expect(elapsedTicketMinutes(at(0), at(100), events)).toBe(50);
    expect(ticketSlaMetric({ startAt: at(0), now: at(100), targetMinutes: 60, events })).toMatchObject({
      elapsedMinutes: 50, state: 'at_risk'
    });
  });

  it('stops resolution time when the ticket closes and reports a breach against its configured target', () => {
    const metric = ticketSlaMetric({ startAt: at(0), stoppedAt: at(65), targetMinutes: 60, events: [] });
    expect(metric).toMatchObject({ elapsedMinutes: 65, state: 'breached', stoppedAt: at(65) });
  });
});
