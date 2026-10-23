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
 * ## Where the tokens live
 *
 * One per remembered account, in `github-vault.json` in `ALPHA_DIR`, so
 * switching between accounts does not go back to GitHub. The installed app
 * seals each with Electron's `safeStorage` (Windows DPAPI: only this Windows
 * user can open them); a daemon run from source has no Electron and writes
 * them readable only by this user (`0600`), as the single credential file
 * always was. Neither stops a process already running as this user.
 *
 * An account unused for `PROFILE_IDLE_LIMIT_MS` (a week) is not resumed or
 * switched to; it authorizes on GitHub again.
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
  /**
   * GitHub App user tokens expire (8 hours by default) and come with a
   * refresh token (6 months). Kept so a remembered account can be renewed
   * through the cloud instead of sending the person back to GitHub.
   */
  refreshToken?: string;
  tokenExpiresAt?: string;
  refreshExpiresAt?: string;
  userId?: string;
  login?: string;
  name?: string;
  avatarUrl?: string;
  obtainedAt: string;
}

/** Where the single active credential lived before accounts were remembered; migrated on first read. */
const TOKEN_FILE = path.join(ALPHA_DIR, 'github-credential.json');
const PROFILE_FILE = path.join(ALPHA_DIR, 'github-profiles.json');
/** Every remembered account's credential, sealed where the OS can seal it. */
const VAULT_FILE = path.join(ALPHA_DIR, 'github-vault.json');

/**
 * How long a remembered account stays signed in without being used.
 *
 * Switching between remembered accounts does not go back to GitHub, so this
 * is what bounds a forgotten one: an account nobody has opened for a week has
 * to be authorized again.
 */
export const PROFILE_IDLE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

/** Public metadata shown by the desktop profile picker. It never contains a token. */
export interface ProfileSummary {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  lastUsedAt: string;
  active: boolean;
  /** Can be switched to without GitHub: a stored credential, used within the idle limit. */
  remembered: boolean;
}

/**
 * Encryption for secrets at rest, supplied by the desktop shell.
 *
 * The packaged app sets this from Electron's `safeStorage` (Windows DPAPI:
 * readable only by this Windows user) before it loads the daemon. A daemon run
 * from source has no Electron, so it falls back to a file readable only by
 * this user -- the protection the single credential file always had.
 */
interface SecretSealer {
  available(): boolean;
  seal(plain: string): string;
  open(sealed: string): string;
}

function sealer(): SecretSealer | null {
  const candidate = (globalThis as { __alphaSecretSealer?: SecretSealer }).__alphaSecretSealer;
  try {
    return candidate?.available() ? candidate : null;
  } catch {
    return null;
  }
}

interface VaultEntry {
  sealing: 'os' | 'none';
  data: string;
}

interface Vault {
  entries: Record<string, VaultEntry>;
}

function readVault(): Vault {
  try {
    const raw = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')) as Partial<Vault>;
    return { entries: raw.entries && typeof raw.entries === 'object' ? raw.entries : {} };
  } catch {
    return { entries: {} };
  }
}

function writeVault(vault: Vault): void {
  fs.mkdirSync(ALPHA_DIR, { recursive: true });
  const temporary = `${VAULT_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(vault, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, VAULT_FILE);
}

function rememberCredential(profileId: string, credential: StoredCredential): void {
  const plain = JSON.stringify(credential);
  const os = sealer();
  const vault = readVault();
  vault.entries[profileId] = os ? { sealing: 'os', data: os.seal(plain) } : { sealing: 'none', data: plain };
  writeVault(vault);
}

function rememberedCredential(profileId: string): StoredCredential | null {
  const entry = readVault().entries[profileId];
  if (!entry) return null;
  try {
    const plain = entry.sealing === 'os' ? sealer()?.open(entry.data) : entry.data;
    if (!plain) return null;
    const credential = JSON.parse(plain) as StoredCredential;
    return credential?.token ? credential : null;
  } catch {
    // Sealed by another Windows user, or on another machine: unreadable here.
    return null;
  }
}

function forgetCredential(profileId: string): void {
  const vault = readVault();
  if (!(profileId in vault.entries)) return;
  delete vault.entries[profileId];
  writeVault(vault);
}

function withinIdleLimit(profile: Pick<ProfileRecord, 'lastUsedAt'>, now = Date.now()): boolean {
  const lastUsed = Date.parse(profile.lastUsedAt);
  return Number.isFinite(lastUsed) && now - lastUsed <= PROFILE_IDLE_LIMIT_MS;
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
  signedOut?: boolean;
  profiles: ProfileRecord[];
}

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

let cached: StoredCredential | null | undefined;
let cachedRegistry: ProfileRegistry | undefined;
/**
 * Whether this process is signed in, as opposed to merely remembering accounts.
 *
 * A packaged desktop starts signed out and signs in by resuming the last
 * account it used (`resumeRememberedSession`) or by a GitHub authorization.
 * Resuming is only allowed within `PROFILE_IDLE_LIMIT_MS` of that account's
 * last use; past it the account must authorize on GitHub again. Application
 * API calls are gated on this until then.
 */
let sessionAuthenticated = false;
let sessionResume: Promise<void> = Promise.resolve();
let sessionAuthenticationError: string | undefined;

export function isSessionAuthenticated(): boolean {
  return sessionAuthenticated;
}

/** An explicit sign-out also disables source builds' machine-login fallback. */
export function requiresSessionAuthentication(): boolean {
  return IS_PACKAGED_DESKTOP || readRegistry().signedOut === true;
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
    cachedRegistry = {
      activeProfileId: typeof raw.activeProfileId === 'string' ? raw.activeProfileId : undefined,
      signedOut: raw.signedOut === true,
      profiles
    };
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

/**
 * Move the pre-vault single credential into the vault, once.
 *
 * Before accounts were remembered, the active account's token sat alone in
 * `github-credential.json`. It becomes that account's vault entry -- sealed,
 * where the OS can -- and the plain file goes.
 */
function migrateLegacyCredential(): void {
  let legacy: StoredCredential | null = null;
  try {
    legacy = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as StoredCredential;
  } catch {
    return; // Nothing to migrate.
  }
  const id = legacy?.token ? profileIdFor(legacy) : undefined;
  if (legacy && id && !readVault().entries[id]) rememberCredential(id, legacy);
  try {
    fs.rmSync(TOKEN_FILE, { force: true });
  } catch (err) {
    logError('Could not remove the pre-vault GitHub credential:', err);
  }
}

/** The active account's stored credential, or null. Read once and kept, since it rarely changes. */
export function storedCredential(): StoredCredential | null {
  if (cached !== undefined) return cached;
  migrateLegacyCredential();
  const activeId = readRegistry().activeProfileId;
  // No active account, unreadable, or not JSON. All mean "not signed in",
  // which is a state the caller handles rather than an error worth logging.
  cached = activeId ? rememberedCredential(activeId) : null;
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
  const vault = readVault();
  return [...registry.profiles]
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .map(profile => ({
      ...profile,
      active: profile.id === activeId && Boolean(storedToken()) && (!IS_PACKAGED_DESKTOP || sessionAuthenticated),
      remembered: Boolean(vault.entries[profile.id]) && withinIdleLimit(profile)
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
  cached = credential;
  sessionAuthenticated = true;
  sessionAuthenticationError = undefined;
  const registry = readRegistry();
  delete registry.signedOut;

  const id = profileIdFor(credential);
  // Kept against the account it belongs to, so switching back to it later does
  // not need GitHub. With no account to key it by (GitHub did not say who it
  // was), it serves this session only.
  if (id) rememberCredential(id, credential);
  if (id && credential.login) {
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
  }
  writeRegistry(registry);
}

/**
 * Forget Alpha's sign-in. Nothing else on the machine is touched -- in
 * particular, the developer's own `gh` login is none of Alpha's business.
 */
export function clearCredential(): void {
  const registry = readRegistry();
  // Signing out forgets this account's credential; the others stay remembered.
  if (registry.activeProfileId) forgetCredential(registry.activeProfileId);
  cached = null;
  sessionAuthenticated = false;
  sessionAuthenticationError = undefined;
  registry.activeProfileId = undefined;
  registry.signedOut = true;
  writeRegistry(registry);
}

/** Remove a remembered profile and its credential, signing out if it was the active one. */
export function removeProfile(profileId: string): void {
  const registry = readRegistry();
  registry.profiles = registry.profiles.filter(profile => profile.id !== profileId);
  forgetCredential(profileId);
  if (registry.activeProfileId === profileId) {
    cached = null;
    sessionAuthenticated = false;
    registry.activeProfileId = undefined;
  }
  writeRegistry(registry);
}

/** Why a remembered account could not be switched to without GitHub. */
export type SwitchRefusal = 'unknown_profile' | 'idle' | 'no_credential' | 'expired' | 'unverified';

export type SwitchResult = { ok: true; login: string } | { ok: false; reason: SwitchRefusal; login?: string };

/** Refresh this long before a token's expiry, so a switch never lands on one about to lapse. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * A credential whose access token can be used now, renewing it if it has
 * lapsed; null if it cannot be.
 *
 * Renewal needs the app's client secret, which only the cloud holds, so the
 * refresh token is exchanged through `ALPHA_CLOUD_API`.
 */
export async function usableCredential(
  credential: StoredCredential,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<StoredCredential | null> {
  const expiresAt = credential.tokenExpiresAt ? Date.parse(credential.tokenExpiresAt) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt - now > TOKEN_REFRESH_MARGIN_MS) return credential;

  const refreshExpiresAt = credential.refreshExpiresAt ? Date.parse(credential.refreshExpiresAt) : NaN;
  if (!credential.refreshToken || !ALPHA_CLOUD_API) return null;
  if (Number.isFinite(refreshExpiresAt) && refreshExpiresAt <= now) return null;

  try {
    const res = await fetchImpl(`${ALPHA_CLOUD_API}/github/oauth/desktop/refresh`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: credential.refreshToken })
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<HostedOAuthTokens>;
    if (!body.token) return null;
    return {
      ...credential,
      token: body.token,
      refreshToken: body.refreshToken ?? credential.refreshToken,
      tokenExpiresAt: body.tokenExpiresAt,
      refreshExpiresAt: body.refreshExpiresAt ?? credential.refreshExpiresAt,
      obtainedAt: new Date(now).toISOString()
    };
  } catch (err) {
    logError('Could not renew a remembered GitHub sign-in:', (err as Error).message);
    return null;
  }
}

/**
 * Switch to a remembered account without going to GitHub.
 *
 * Allowed while the account was used within `PROFILE_IDLE_LIMIT_MS` and its
 * credential still works: GitHub is asked who the token belongs to, and it has
 * to be this account. Anything else answers why, and the picker falls back to
 * authorizing on GitHub. An idle, lapsed or mismatched credential is forgotten;
 * one that merely could not be checked (offline) is kept for the next try.
 */
export async function switchToProfile(
  profileId: string,
  options: { fetchImpl?: typeof fetch; now?: number } = {}
): Promise<SwitchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const registry = readRegistry();
  const profile = registry.profiles.find(candidate => candidate.id === profileId);
  if (!profile) return { ok: false, reason: 'unknown_profile' };

  if (!withinIdleLimit(profile, now)) {
    forgetCredential(profileId);
    return { ok: false, reason: 'idle', login: profile.login };
  }

  const stored = rememberedCredential(profileId);
  if (!stored) return { ok: false, reason: 'no_credential', login: profile.login };

  const credential = await usableCredential(stored, fetchImpl, now);
  if (!credential) {
    forgetCredential(profileId);
    return { ok: false, reason: 'expired', login: profile.login };
  }

  const user = await userFor(credential.token, fetchImpl);
  if (!user?.login) return { ok: false, reason: 'unverified', login: profile.login };
  if (user.login.toLowerCase() !== profile.login.toLowerCase()) {
    forgetCredential(profileId);
    return { ok: false, reason: 'expired', login: profile.login };
  }

  saveCredential({
    ...credential,
    userId: user.id ?? credential.userId,
    login: user.login,
    name: user.name ?? credential.name,
    avatarUrl: user.avatarUrl ?? credential.avatarUrl
  });
  return { ok: true, login: user.login };
}

/**
 * On launch, sign back in as the last account used, if it is still allowed to.
 *
 * Started once by the daemon at boot. Anything that decides whether the
 * process is signed in waits on `sessionReady()` first, so the first request
 * from the window does not see the brief signed-out state before this lands.
 */
export function resumeRememberedSession(options: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<void> {
  sessionResume = (async () => {
    storedCredential(); // Migrates a pre-vault credential first, so it can be resumed.
    const activeId = readRegistry().activeProfileId;
    if (!activeId || sessionAuthenticated) return;
    const result = await switchToProfile(activeId, options);
    if (result.ok) logInfo(`Resumed the remembered GitHub account ${result.login}`);
  })().catch(err => {
    logError('Could not resume the remembered GitHub account:', (err as Error).message);
  });
  return sessionResume;
}

/** Resolves once any launch-time resume has settled. */
export function sessionReady(): Promise<void> {
  return sessionResume;
}

/** How often an account in use has its last use recorded; see `touchActiveProfile`. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Record that the signed-in account is still in use.
 *
 * The idle limit counts from last use, and an app left open for days is in
 * use. At most once an hour, so a status poll does not rewrite the file.
 */
export function touchActiveProfile(now = Date.now()): void {
  if (!sessionAuthenticated && IS_PACKAGED_DESKTOP) return;
  const registry = readRegistry();
  const profile = registry.profiles.find(candidate => candidate.id === registry.activeProfileId);
  if (!profile) return;
  const lastUsed = Date.parse(profile.lastUsedAt);
  if (Number.isFinite(lastUsed) && now - lastUsed < TOUCH_INTERVAL_MS) return;
  profile.lastUsedAt = new Date(now).toISOString();
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

/** An access token and what renews it, as the cloud hands them over. */
export interface HostedOAuthTokens {
  token: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  refreshExpiresAt?: string;
}

export interface HostedOAuthCredential extends HostedOAuthTokens {
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
      ...(body.refreshToken ? { refreshToken: body.refreshToken } : {}),
      ...(body.tokenExpiresAt ? { tokenExpiresAt: body.tokenExpiresAt } : {}),
      ...(body.refreshExpiresAt ? { refreshExpiresAt: body.refreshExpiresAt } : {}),
      ...(body.profileId ? { profileId: body.profileId } : {}),
      ...(body.name ? { name: body.name } : {}),
      ...(body.avatarUrl ? { avatarUrl: body.avatarUrl } : {})
    };
    saveCredential({
      token: credential.token,
      ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
      ...(credential.tokenExpiresAt ? { tokenExpiresAt: credential.tokenExpiresAt } : {}),
      ...(credential.refreshExpiresAt ? { refreshExpiresAt: credential.refreshExpiresAt } : {}),
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

/**
 * GitHub's token response, in the shape Alpha stores; null if it holds no token.
 *
 * `expires_in` and `refresh_token_expires_in` are seconds from now, and are
 * absent for a token that does not expire (an OAuth app, or a GitHub App with
 * expiring tokens turned off).
 */
export function tokensFromGitHub(body: Record<string, unknown>, now = Date.now()): HostedOAuthTokens | null {
  const token = typeof body.access_token === 'string' ? body.access_token : '';
  if (!token) return null;
  const seconds = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const expiresIn = seconds(body.expires_in);
  const refreshIn = seconds(body.refresh_token_expires_in);
  return {
    token,
    ...(typeof body.refresh_token === 'string' && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(expiresIn ? { tokenExpiresAt: new Date(now + expiresIn * 1000).toISOString() } : {}),
    ...(refreshIn ? { refreshExpiresAt: new Date(now + refreshIn * 1000).toISOString() } : {})
  };
}

/** One exchange attempt: the token, or why it is not ready. */
type PollResult =
  | { status: 'granted'; token: string; tokens: HostedOAuthTokens }
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
  const tokens = tokensFromGitHub(body);
  if (tokens) return { status: 'granted', token: tokens.token, tokens };

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
        ...result.tokens,
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
