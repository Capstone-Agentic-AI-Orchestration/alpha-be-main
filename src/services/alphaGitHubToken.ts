import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ALPHA_CLOUD_API, ALPHA_DIR, GITHUB_CLIENT_ID, GITHUB_SCOPE, IS_PACKAGED_DESKTOP } from '../config/env.js';
import { logError, logInfo } from '../utils/logger.js';

/**
 * Alpha's own GitHub credential, so the desktop stops borrowing the machine's.
 *
 * ## What this replaces
 *
 * Identity used to be whatever `gh auth login` had been run as. That made the
 * app an observer of a setting it did not own: the person shown in Alpha was
 * decided outside it, could change under it without warning, and signing out of
 * Alpha ran `gh auth logout` -- logging the machine out of GitHub for every
 * other tool that used it. A shared machine, or one developer with two
 * accounts, had no way to say which one Alpha was.
 *
 * Alpha now holds a token of its own, obtained by a sign-in inside the app.
 * `gh` is still how the work gets done -- cloning, pushing, opening pull
 * requests -- but it is handed this token through `GH_TOKEN`, which it prefers
 * over anything stored on the machine. So the account is Alpha's, and the
 * machine's own `gh` login is left exactly as the developer set it.
 *
 * ## How GitHub sign-in works
 *
 * A desktop app cannot keep a client secret: whatever ships inside an installer
 * is readable by anyone who has the installer. Installed builds therefore use
 * the hosted OAuth handoff when `ALPHA_CLOUD_API` is available: the cloud keeps
 * the secret, includes the requested GitHub login in the authorize URL, and
 * returns the one-time credential to the local daemon. A device flow remains
 * available for standalone/source runs, where no hosted handoff is configured.
 * It also means sign-in works on a machine where the app cannot register a URL
 * scheme.
 *
 * ## Where the token lives
 *
 * A file in `ALPHA_DIR`, written `0600` -- readable by this user and nobody
 * else on the machine. That is weaker than the OS keyring, and deliberately so
 * for now: the daemon is a plain Node process that also runs from source, with
 * no Electron to reach `safeStorage` through. The threat it does close is
 * another account on a shared machine reading the file; the one it does not is
 * a process already running as this user, which could equally read the keyring
 * by asking the OS nicely.
 */

/** A GitHub sign-in that could not be completed, with something to do about it. */
export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

interface StoredCredential {
  token: string;
  userId?: string;
  login?: string;
  name?: string;
  avatarUrl?: string;
  obtainedAt: string;
}

const TOKEN_FILE = path.join(ALPHA_DIR, 'github-credential.json');
const PROFILE_FILE = path.join(ALPHA_DIR, 'github-profiles.json');

/** Public metadata shown by the desktop profile picker. It never contains a token. */
export interface ProfileSummary {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  lastUsedAt: string;
  active: boolean;
}

interface ProfileRecord {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  lastUsedAt: string;
}

interface ProfileRegistry {
  activeProfileId?: string;
  profiles: ProfileRecord[];
}

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

let cached: StoredCredential | null | undefined;
let cachedRegistry: ProfileRegistry | undefined;
/**
 * A profile being remembered is not the same as this process being signed in.
 * Packaged desktop builds intentionally start with a fresh session so an old
 * token on disk cannot silently choose an account for the next person at the
 * keyboard. The token remains available for the updater, but application API
 * calls are gated until a fresh GitHub authorization completes in this process.
 */
let sessionAuthenticated = false;
let sessionAuthenticationError: string | undefined;

export function isSessionAuthenticated(): boolean {
  return sessionAuthenticated;
}

export function getSessionAuthenticationError(): string | undefined {
  return sessionAuthenticationError;
}

/** Keep an async sign-in failure available to the local profile picker. */
export function setSessionAuthenticationError(message: string | undefined): void {
  if (!message) {
    sessionAuthenticationError = undefined;
    return;
  }
  sessionAuthenticationError = message
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1[redacted]')
    .replace(/([A-Za-z]:\\[^\s"']+|\\\\[^\s"']+)/g, '[local path]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 240) || 'GitHub sign-in could not be completed. Please try again.';
}

/** Begin (or restart) a device sign-in without deleting remembered metadata. */
export function beginSessionAuthentication(): void {
  sessionAuthenticated = false;
  sessionAuthenticationError = undefined;
}

function readRegistry(): ProfileRegistry {
  if (cachedRegistry) return cachedRegistry;
  try {
    const raw = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')) as Partial<ProfileRegistry>;
    const profiles = Array.isArray(raw.profiles)
      ? raw.profiles.filter(profile =>
          profile && typeof profile.id === 'string' && typeof profile.login === 'string'
        ) as ProfileRecord[]
      : [];
    cachedRegistry = { activeProfileId: typeof raw.activeProfileId === 'string' ? raw.activeProfileId : undefined, profiles };
  } catch {
    cachedRegistry = { profiles: [] };
  }
  return cachedRegistry;
}

function writeRegistry(registry: ProfileRegistry): void {
  fs.mkdirSync(ALPHA_DIR, { recursive: true });
  const temporary = `${PROFILE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, PROFILE_FILE);
  cachedRegistry = registry;
}

function profileIdFor(credential: Pick<StoredCredential, 'userId' | 'login'>): string | undefined {
  const userId = credential.userId?.trim();
  if (userId) return userId;
  const login = credential.login?.trim().toLowerCase();
  return login || undefined;
}

/** The stored credential, or null. Read once and kept, since it rarely changes. */
export function storedCredential(): StoredCredential | null {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as StoredCredential;
    if (!cached?.token) cached = null;
  } catch {
    // No file, unreadable, or not JSON. All mean "not signed in", which is a
    // state the caller handles rather than an error worth logging every time.
    cached = null;
  }
  return cached;
}

export const storedToken = (): string | null => storedCredential()?.token ?? null;

/** Profiles Alpha has seen on this Windows user account. Tokens stay private. */
export function profileSummaries(): ProfileSummary[] {
  const registry = readRegistry();
  const credential = storedCredential();
  const activeCredentialId = credential ? profileIdFor(credential) : undefined;
  if (credential?.login && activeCredentialId && !registry.profiles.some(profile => profile.id === activeCredentialId)) {
    registry.profiles.push({
      id: activeCredentialId,
      login: credential.login,
      ...(credential.name ? { name: credential.name } : {}),
      ...(credential.avatarUrl ? { avatarUrl: credential.avatarUrl } : {}),
      lastUsedAt: credential.obtainedAt
    });
    registry.activeProfileId = activeCredentialId;
    writeRegistry(registry);
  }
  const activeId = registry.activeProfileId;
  return [...registry.profiles]
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .map(profile => ({
      ...profile,
      active: profile.id === activeId && Boolean(storedToken()) && (!IS_PACKAGED_DESKTOP || sessionAuthenticated)
    }));
}

export function activeProfile(): ProfileSummary | null {
  return profileSummaries().find(profile => profile.active) ?? null;
}

/**
 * An environment that runs `gh` as Alpha rather than as the machine.
 *
 * `gh` prefers `GH_TOKEN` over any credential stored on the machine, so this
 * one variable is the whole of the decoupling -- the CLI still does the
 * cloning, the pushing and the pull requests, it just does them as the account
 * chosen in the app.
 *
 * With no stored credential the environment is passed through untouched, so a
 * daemon run from source by a developer who already has `gh` signed in keeps
 * working while they are setting up.
 */
export function ghEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const token = !IS_PACKAGED_DESKTOP || sessionAuthenticated ? storedToken() : null;
  const base = { ...process.env, ...extra };
  return token ? { ...base, GH_TOKEN: token } : base;
}

export function saveCredential(credential: StoredCredential): void {
  fs.mkdirSync(ALPHA_DIR, { recursive: true });
  // Written 0600 at creation rather than chmod-ed after, so it is never briefly
  // world-readable. `mode` is ignored on Windows, where the user profile
  // directory is the protection instead.
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(credential, null, 2) + '\n', { mode: 0o600 });
  cached = credential;
  sessionAuthenticated = true;
  sessionAuthenticationError = undefined;

  const id = profileIdFor(credential);
  if (id && credential.login) {
    const registry = readRegistry();
    const now = new Date().toISOString();
    const existing = registry.profiles.find(profile => profile.id === id);
    const record: ProfileRecord = {
      id,
      login: credential.login,
      ...(credential.name ? { name: credential.name } : existing?.name ? { name: existing.name } : {}),
      ...(credential.avatarUrl ? { avatarUrl: credential.avatarUrl } : existing?.avatarUrl ? { avatarUrl: existing.avatarUrl } : {}),
      lastUsedAt: now
    };
    registry.profiles = [record, ...registry.profiles.filter(profile => profile.id !== id)];
    registry.activeProfileId = id;
    writeRegistry(registry);
  }
}

/**
 * Forget Alpha's sign-in. Nothing else on the machine is touched -- in
 * particular, the developer's own `gh` login is none of Alpha's business.
 */
export function clearCredential(): void {
  try {
    fs.rmSync(TOKEN_FILE, { force: true });
  } catch (err) {
    logError('Could not remove the stored GitHub credential:', err);
  }
  cached = null;
  sessionAuthenticated = false;
  sessionAuthenticationError = undefined;
  const registry = readRegistry();
  registry.activeProfileId = undefined;
  writeRegistry(registry);
}

/** Remove a remembered profile and its active credential, if selected. */
export function removeProfile(profileId: string): void {
  const registry = readRegistry();
  registry.profiles = registry.profiles.filter(profile => profile.id !== profileId);
  if (registry.activeProfileId === profileId) {
    try {
      fs.rmSync(TOKEN_FILE, { force: true });
    } catch (err) {
      logError('Could not remove the profile credential:', err);
    }
    cached = null;
    sessionAuthenticated = false;
    registry.activeProfileId = undefined;
  }
  writeRegistry(registry);
}

/**
 * The client id to sign in against.
 *
 * Configured directly when the daemon has it, which is how the cloud and a
 * from-source desktop run. An installed desktop has no GitHub configuration of
 * its own -- only the four public settings baked into the build -- so it asks
 * the deployment it belongs to. A client id is public by construction: it
 * appears in every authorisation URL a browser ever shows.
 */
export async function clientId(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (GITHUB_CLIENT_ID) return GITHUB_CLIENT_ID;
  if (!ALPHA_CLOUD_API) {
    throw new DeviceFlowError(
      'This build has no GitHub client id and no ALPHA_CLOUD_API to ask for one, so it cannot sign in.'
    );
  }

  try {
    const res = await fetchImpl(`${ALPHA_CLOUD_API}/github/app/client`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = (await res.json()) as { clientId?: string };
    if (!body.clientId) throw new Error('no clientId in the response');
    return body.clientId;
  } catch (err) {
    throw new DeviceFlowError(
      `Could not ask ${ALPHA_CLOUD_API} which GitHub app to sign in to: ${(err as Error).message}`
    );
  }
}

/**
 * A hosted OAuth handoff for an installed desktop.
 *
 * The browser flow is the only GitHub flow that can target a remembered
 * account (`login`) and force the account chooser (`prompt=select_account`).
 * The desktop cannot exchange that callback itself because its client secret
 * must stay on the hosted service, so the cloud keeps the result briefly and
 * the local daemon retrieves it with this one-time bearer value.
 */
export interface HostedOAuthStart {
  state: string;
  handoffToken: string;
  authorizationUrl: string;
}

export interface HostedOAuthCredential {
  token: string;
  username: string;
  profileId?: string;
  name?: string;
  avatarUrl?: string;
}

export async function requestHostedOAuth(
  profileLogin?: string,
  fetchImpl: typeof fetch = fetch
): Promise<HostedOAuthStart> {
  if (!ALPHA_CLOUD_API) {
    throw new DeviceFlowError(
      'This desktop has no hosted Alpha API configured for account-specific GitHub sign-in.'
    );
  }

  const handoffToken = crypto.randomBytes(32).toString('hex');
  const res = await fetchImpl(`${ALPHA_CLOUD_API}/github/oauth/desktop/start`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      handoffToken,
      ...(profileLogin ? { login: profileLogin } : {})
    })
  });
  // The hosted backend's desktop-start route currently names this field `url`;
  // accept `authorizationUrl` as well so the local daemon remains compatible
  // with deployments that already use the more descriptive response name.
  const body = (await res.json().catch(() => ({}))) as {
    state?: string;
    url?: string;
    authorizationUrl?: string;
    error?: string;
  };
  const authorizationUrl = body.authorizationUrl ?? body.url;
  if (!res.ok || !body.state || !authorizationUrl) {
    throw new DeviceFlowError(
      body.error || `Alpha could not start account-specific GitHub sign-in (${res.status}).`
    );
  }

  return { state: body.state, handoffToken, authorizationUrl };
}

/** Wait for the hosted callback, then store the credential locally. */
export async function awaitHostedOAuth(
  flow: HostedOAuthStart,
  options: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {}
): Promise<HostedOAuthCredential> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60 * 1000);
  const resultUrl = `${ALPHA_CLOUD_API}/github/oauth/desktop/result?state=${encodeURIComponent(flow.state)}&handoff=${encodeURIComponent(flow.handoffToken)}`;

  while (Date.now() < deadline) {
    const res = await fetchImpl(resultUrl, { headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as Partial<HostedOAuthCredential> & {
      status?: string;
      error?: string;
    };

    if (res.status === 202 && body.status === 'pending') {
      await sleep(2500);
      continue;
    }
    if (!res.ok || !body.token || !body.username) {
      throw new DeviceFlowError(body.error || 'Hosted GitHub authorization did not complete.');
    }

    const credential: HostedOAuthCredential = {
      token: body.token,
      username: body.username,
      ...(body.profileId ? { profileId: body.profileId } : {}),
      ...(body.name ? { name: body.name } : {}),
      ...(body.avatarUrl ? { avatarUrl: body.avatarUrl } : {})
    };
    saveCredential({
      token: credential.token,
      login: credential.username,
      ...(credential.profileId ? { userId: credential.profileId } : {}),
      ...(credential.name ? { name: credential.name } : {}),
      ...(credential.avatarUrl ? { avatarUrl: credential.avatarUrl } : {}),
      obtainedAt: new Date().toISOString()
    });
    return credential;
  }

  throw new DeviceFlowError('That GitHub authorization expired before Alpha received it. Start sign-in again.');
}

export interface DeviceCode {
  /** Shown to the person; they type it into GitHub. */
  userCode: string;
  verificationUrl: string;
  /** Held by Alpha, exchanged for the token. Never shown. */
  deviceCode: string;
  /** Seconds GitHub asks us to wait between polls. */
  interval: number;
  expiresIn: number;
}

export async function requestDeviceCode(fetchImpl: typeof fetch = fetch): Promise<DeviceCode> {
  const id = await clientId(fetchImpl);
  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    // A GitHub App ignores `scope` -- its access comes from the permissions it
    // was installed with -- but an OAuth app needs it, and sending it costs
    // nothing either way.
    body: JSON.stringify({ client_id: id, scope: GITHUB_SCOPE.split(',').map(s => s.trim()).join(' ') })
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || !body.device_code || !body.user_code) {
    throw new DeviceFlowError(
      body.error_description ||
        body.error ||
        `GitHub refused to start a sign-in (${res.status}). Check that device flow is enabled on the app.`
    );
  }

  return {
    userCode: body.user_code,
    verificationUrl: body.verification_uri || 'https://github.com/login/device',
    deviceCode: body.device_code,
    interval: Number(body.interval) || 5,
    expiresIn: Number(body.expires_in) || 900
  };
}

/** One exchange attempt: the token, or why it is not ready. */
type PollResult =
  | { status: 'granted'; token: string }
  | { status: 'pending'; slowDown: boolean }
  | { status: 'failed'; message: string };

export async function pollOnce(deviceCode: string, fetchImpl: typeof fetch = fetch): Promise<PollResult> {
  const id = await clientId(fetchImpl);
  const res = await fetchImpl(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: id,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (body.access_token) return { status: 'granted', token: body.access_token };

  switch (body.error) {
    // The person has not finished in the browser yet. Expected, repeatedly.
    case 'authorization_pending':
      return { status: 'pending', slowDown: false };
    // GitHub says we are asking too often; back off rather than get blocked.
    case 'slow_down':
      return { status: 'pending', slowDown: true };
    case 'expired_token':
      return { status: 'failed', message: 'That code expired. Start the sign-in again.' };
    case 'access_denied':
      return { status: 'failed', message: 'The sign-in was declined on GitHub.' };
    default:
      return {
        status: 'failed',
        message: body.error_description || body.error || 'GitHub would not complete the sign-in.'
      };
  }
}

/** Public GitHub account metadata, asked of GitHub rather than assumed. */
export interface GitHubUser {
  id?: string;
  login?: string;
  name?: string;
  avatarUrl?: string;
}

export async function userFor(token: string, fetchImpl: typeof fetch = fetch): Promise<GitHubUser | undefined> {
  try {
    const res = await fetchImpl('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return undefined;
    const user = (await res.json()) as { id?: number; login?: string; name?: string; avatar_url?: string };
    return {
      id: user.id === undefined ? undefined : String(user.id),
      login: user.login,
      name: user.name || undefined,
      avatarUrl: user.avatar_url || undefined
    };
  } catch {
    return undefined;
  }
}

/** Backwards-compatible login lookup for existing GitHub service callers. */
export async function loginFor(token: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  return (await userFor(token, fetchImpl))?.login;
}

/**
 * Wait for the person to finish in their browser, then keep the token.
 *
 * Resolves when the sign-in completes and rejects when it cannot -- the caller
 * runs this in the background while the UI polls the auth status, which is what
 * it already did when `gh` drove this.
 */
export async function awaitAuthorization(
  code: DeviceCode,
  options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}
): Promise<StoredCredential> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  let interval = code.interval;
  const deadline = Date.now() + code.expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const result = await pollOnce(code.deviceCode, fetchImpl);

    if (result.status === 'granted') {
      const user = await userFor(result.token, fetchImpl);
      const credential: StoredCredential = {
        token: result.token,
        userId: user?.id,
        login: user?.login,
        name: user?.name,
        avatarUrl: user?.avatarUrl,
        obtainedAt: new Date().toISOString()
      };
      saveCredential(credential);
      logInfo(`Signed in to GitHub as ${credential.login ?? 'an account'} (Alpha's own credential)`);
      return credential;
    }

    if (result.status === 'failed') throw new DeviceFlowError(result.message);
    if (result.slowDown) interval += 5;
  }

  throw new DeviceFlowError('That code expired before it was authorised. Start the sign-in again.');
}
