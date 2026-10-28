import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }));
import { TicketClientIdentityProvider } from './ticketClientIdentityProvider.js';

const user = { id: 'client-identity', email: 'client@example.test', email_confirmed_at: new Date().toISOString() };
let admin: { generateLink: ReturnType<typeof vi.fn>; updateUserById: ReturnType<typeof vi.fn>; getUserById: ReturnType<typeof vi.fn> };
let verify: ReturnType<typeof vi.fn>;
let clients: Array<{ auth: { signInWithPassword: ReturnType<typeof vi.fn>; verifyOtp: ReturnType<typeof vi.fn> } }>;
let provider: TicketClientIdentityProvider;
beforeEach(() => {
  clients = [];
  admin = { generateLink: vi.fn(), updateUserById: vi.fn(async () => ({ data: { user }, error: null })),
    getUserById: vi.fn(async () => ({ data: { user }, error: null })) };
  verify = vi.fn(async () => ({ data: { user }, error: null }));
  mocks.create.mockReset();
  mocks.create.mockImplementation(() => {
    const client = { auth: { admin, getUser: verify,
      signInWithPassword: vi.fn(async () => ({ data: { session: { access_token: 'credential' } }, error: null })),
      verifyOtp: vi.fn(async () => ({ data: { session: { access_token: 'credential' } }, error: null })) } };
    clients.push(client); return client;
  });
  provider = new TicketClientIdentityProvider('https://project.supabase.co', 'publishable', 'server-secret');
});

describe('client identity password provider boundary', () => {
  it('isolates provider sessions for parallel sign-in and email-proof requests', async () => {
    await Promise.all([provider.signInWithPassword(user.email, 'password-123'), provider.signInWithPassword(user.email, 'password-456')]);
    await provider.verifyEmailLink('provider-proof-with-sufficient-length', 'recovery');
    expect(clients).toHaveLength(5);
    expect(clients[2].auth.signInWithPassword).toHaveBeenCalledWith({ email: user.email, password: 'password-123' });
    expect(clients[3].auth.signInWithPassword).toHaveBeenCalledWith({ email: user.email, password: 'password-456' });
    expect(clients[4].auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'provider-proof-with-sufficient-length', type: 'recovery' });
    for (const call of mocks.create.mock.calls) expect(call[2].auth.persistSession).toBe(false);
  });
  it('sets a password only on the identity proven by the provider credential', async () => {
    await provider.setPassword('credential', 'password-123');
    expect(verify).toHaveBeenCalledWith('credential');
    expect(admin.updateUserById).toHaveBeenCalledWith(user.id, { password: 'password-123' });
    verify.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(provider.setPassword('bad-proof', 'password-123')).rejects.toThrow('unavailable');
    expect(admin.updateUserById).toHaveBeenCalledTimes(1);
  });
  it('generates recovery proof for the existing identity using the server-only client', async () => {
    admin.generateLink.mockResolvedValue({ data: { user, properties: { hashed_token: 'recovery-proof', verification_type: 'recovery' } }, error: null });
    await expect(provider.generateRecoveryLink(user.email)).resolves.toEqual({ userId: user.id, tokenHash: 'recovery-proof' });
    expect(admin.generateLink).toHaveBeenCalledWith({ type: 'recovery', email: user.email });
  });
  it('returns only a currently confirmed email for the exact provider user ID', async () => {
    await expect(provider.getVerifiedEmail(user.id)).resolves.toBe(user.email);
    expect(admin.getUserById).toHaveBeenCalledWith(user.id);
    admin.getUserById.mockResolvedValueOnce({ data: { user: { ...user, id: 'different-user' } }, error: null });
    await expect(provider.getVerifiedEmail(user.id)).resolves.toBeNull();
    admin.getUserById.mockResolvedValueOnce({ data: { user: { ...user, email_confirmed_at: null } }, error: null });
    await expect(provider.getVerifiedEmail(user.id)).resolves.toBeNull();
  });
});
