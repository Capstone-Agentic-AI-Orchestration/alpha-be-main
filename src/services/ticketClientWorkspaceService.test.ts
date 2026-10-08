import { describe, expect, it, vi } from 'vitest';

import type { TicketClientWorkspaceRecord, TicketClientWorkspaceStore } from '../store/ticketClientWorkspaceStore.js';
import type { TicketSubject } from '../store/ticketCommandStore.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import { createTicketClientWorkspaceService } from './ticketClientWorkspaceService.js';

const client: TicketSubject = { kind: 'client', userId: 'client-1', sessionId: 'a'.repeat(64) };

function fixture(rows: TicketClientWorkspaceRecord[]) {
  const listAuthorizedWorkspaces = vi.fn(async () => rows);
  const store = {
    transaction: vi.fn(async (work: (tx: { listAuthorizedWorkspaces: typeof listAuthorizedWorkspaces }) => Promise<unknown>) =>
      work({ listAuthorizedWorkspaces })),
  } as unknown as TicketClientWorkspaceStore;
  return { service: createTicketClientWorkspaceService(store), store, listAuthorizedWorkspaces };
}

describe('client workspace selector application service', () => {
  it('returns only explicitly authorized workspace labels, in a stable order', async () => {
    const f = fixture([
      { workspaceId: 'workspace-z', displayName: 'Zeta' },
      { workspaceId: 'workspace-a', displayName: 'Alpha' },
    ]);

    await expect(f.service.list(client)).resolves.toEqual([
      { workspaceId: 'workspace-a', displayName: 'Alpha' },
      { workspaceId: 'workspace-z', displayName: 'Zeta' },
    ]);
    expect(f.listAuthorizedWorkspaces).toHaveBeenCalledWith(client);
    expect(JSON.stringify(await f.service.list(client))).not.toMatch(/ticket|project|repository/i);
  });

  it('refuses internal identities before querying client grants', async () => {
    const f = fixture([]);
    const internal: TicketSubject = { kind: 'internal', userId: 'pm-1', authentication: { kind: 'session', sessionId: 'pm-session' } };

    await expect(f.service.list(internal)).rejects.toMatchObject({ status: 403, code: 'ticket_action_forbidden' });
    expect(f.store.transaction).not.toHaveBeenCalled();
    expect(f.listAuthorizedWorkspaces).not.toHaveBeenCalled();
  });

  it('fails closed when the store returns duplicate or malformed tenant rows', async () => {
    const duplicate = fixture([
      { workspaceId: 'workspace-1', displayName: 'Alpha' },
      { workspaceId: 'workspace-1', displayName: 'Other label' },
    ]);
    await expect(duplicate.service.list(client)).rejects.toBeInstanceOf(TicketReadInvariantError);

    const malformed = fixture([{ workspaceId: 'workspace-1', displayName: ' Alpha ' }]);
    await expect(malformed.service.list(client)).rejects.toBeInstanceOf(TicketReadInvariantError);
  });
});
