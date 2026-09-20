import { RuntimeEngine } from '../models/index.js';

const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const NPM_PACKAGES: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
  opencode: 'opencode-ai'
};

/** Official release feeds for runtimes that are not distributed through npm. */
const REMOTE_RELEASES: Record<string, string> = {
  ollama: 'https://api.github.com/repos/ollama/ollama/releases/latest'
};

type UpdateFields = Pick<RuntimeEngine,
  'updateAvailable' | 'latestVersion' | 'updateCheckedAt' | 'updateError' | 'updateSource'
>;

type CachedUpdate = {
  installedVersion?: string;
  checkedAtMs: number;
  result: UpdateFields;
};

const cache = new Map<string, CachedUpdate>();

export function extractVersion(value: string | undefined): string | undefined {
  const match = value?.match(/\b\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?\b/);
  return match?.[0];
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.replace(/^[v=]/i, '').split(/[.-]/).map(part => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkNpmPackage(runtime: RuntimeEngine, packageName: string): Promise<UpdateFields> {
  const checkedAt = new Date().toISOString();
  const installedVersion = extractVersion(runtime.version);
  const previous = cache.get(runtime.id);
  if (previous && previous.installedVersion === installedVersion && Date.now() - previous.checkedAtMs < UPDATE_CACHE_TTL_MS) {
    return previous.result;
  }

  if (!installedVersion) {
    const result: UpdateFields = {
      updateSource: 'npm',
      updateCheckedAt: checkedAt,
      updateError: 'Installed runtime version is not machine-readable'
    };
    cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
    return result;
  }

  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      const result: UpdateFields = {
        updateSource: 'npm',
        updateCheckedAt: checkedAt,
        updateError: `Package registry returned HTTP ${response.status}`
      };
      cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
      return result;
    }

    const payload = await response.json() as { version?: unknown };
    const latestVersion = typeof payload.version === 'string' ? extractVersion(payload.version) : undefined;
    const result: UpdateFields = latestVersion
      ? {
          updateSource: 'npm',
          updateCheckedAt: checkedAt,
          latestVersion,
          updateAvailable: compareVersions(latestVersion, installedVersion) > 0
        }
      : {
          updateSource: 'npm',
          updateCheckedAt: checkedAt,
          updateError: 'Package registry returned no readable version'
        };
    cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
    return result;
  } catch {
    const result: UpdateFields = {
      updateSource: 'npm',
      updateCheckedAt: checkedAt,
      updateError: 'Package registry could not be reached'
    };
    cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
    return result;
  }
}

function lmStudioDownloadTarget(): string {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'lin';
}

/**
 * LM Studio publishes the current desktop/llmster version on its official
 * download page rather than a package registry. Prefer the release-notes link,
 * then fall back to the version printed beside the platform download button.
 */
export function parseLatestLmStudioVersion(html: string): string | undefined {
  const releaseNotes = html.match(/\/changelog\/lmstudio-v(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)/i);
  if (releaseNotes?.[1]) return releaseNotes[1];

  const marker = html.search(/Download\s+LM Studio/i);
  if (marker < 0) return undefined;
  const nearby = html.slice(marker, marker + 2000);
  const version = nearby.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/);
  return version?.[1];
}

type RemoteUpdatePayload = { tag_name?: unknown; version?: unknown };

async function checkRemoteRelease(runtime: RuntimeEngine, url: string): Promise<UpdateFields> {
  const checkedAt = new Date().toISOString();
  const installedVersion = extractVersion(runtime.version);
  const previous = cache.get(runtime.id);
  if (previous && previous.installedVersion === installedVersion && Date.now() - previous.checkedAtMs < UPDATE_CACHE_TTL_MS) {
    return previous.result;
  }

  if (!installedVersion) {
    const result: UpdateFields = {
      updateSource: 'remote_api',
      updateCheckedAt: checkedAt,
      updateError: 'Installed runtime version is not machine-readable'
    };
    cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
    return result;
  }

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'Alpha-runtime-catalog'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      const result: UpdateFields = {
        updateSource: 'remote_api',
        updateCheckedAt: checkedAt,
        updateError: `Release feed returned HTTP ${response.status}`
      };
      cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
      return result;
    }

    const payload = await response.json() as RemoteUpdatePayload;
    const latestVersion = extractVersion(
      typeof payload.tag_name === 'string' ? payload.tag_name :
        typeof payload.version === 'string' ? payload.version : undefined
    );
    const result: UpdateFields = latestVersion
      ? {
          updateSource: 'remote_api',
          updateCheckedAt: checkedAt,
          latestVersion,
          updateAvailable: compareVersions(latestVersion, installedVersion) > 0
        }
      : {
          updateSource: 'remote_api',
          updateCheckedAt: checkedAt,
          updateError: 'Release feed returned no readable version'
        };
    cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
    return result;
  } catch {
    const result: UpdateFields = {
      updateSource: 'remote_api',
      updateCheckedAt: checkedAt,
      updateError: 'Release feed could not be reached'
    };
    cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
    return result;
  }
}

async function checkLmStudioUpdate(runtime: RuntimeEngine): Promise<UpdateFields> {
  const checkedAt = new Date().toISOString();
  const installedVersion = extractVersion(runtime.version);
  const previous = cache.get(runtime.id);
  if (previous && previous.installedVersion === installedVersion && Date.now() - previous.checkedAtMs < UPDATE_CACHE_TTL_MS) {
    return previous.result;
  }

  if (!installedVersion) {
    const result: UpdateFields = {
      updateSource: 'remote_api',
      updateCheckedAt: checkedAt,
      updateError: 'Installed LM Studio version is not machine-readable'
    };
    cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
    return result;
  }

  try {
    const response = await fetch(`https://lmstudio.ai/download?os=${lmStudioDownloadTarget()}`, {
      headers: { accept: 'text/html', 'user-agent': 'Alpha-runtime-catalog' },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      const result: UpdateFields = {
        updateSource: 'remote_api',
        updateCheckedAt: checkedAt,
        updateError: `LM Studio download page returned HTTP ${response.status}`
      };
      cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
      return result;
    }

    const latestVersion = parseLatestLmStudioVersion(await response.text());
    const result: UpdateFields = latestVersion
      ? {
          updateSource: 'remote_api',
          updateCheckedAt: checkedAt,
          latestVersion,
          updateAvailable: compareVersions(latestVersion, installedVersion) > 0
        }
      : {
          updateSource: 'remote_api',
          updateCheckedAt: checkedAt,
          updateError: 'LM Studio download page returned no readable version'
        };
    cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
    return result;
  } catch {
    const result: UpdateFields = {
      updateSource: 'remote_api',
      updateCheckedAt: checkedAt,
      updateError: 'LM Studio download page could not be reached'
    };
    cache.set(runtime.id, { installedVersion, checkedAtMs: Date.now(), result });
    return result;
  }
}

async function checkRuntimeUpdate(runtime: RuntimeEngine): Promise<UpdateFields> {
  if (!runtime.version?.trim()) {
    return {
      updateSource: 'none',
      updateCheckedAt: new Date().toISOString()
    };
  }

  const packageName = NPM_PACKAGES[runtime.id];
  if (packageName) return checkNpmPackage(runtime, packageName);

  const remoteRelease = REMOTE_RELEASES[runtime.id];
  if (remoteRelease) return checkRemoteRelease(runtime, remoteRelease);
  if (runtime.id === 'lmstudio') return checkLmStudioUpdate(runtime);
  if (runtime.id === 'antigravity') {
    // Antigravity owns its update lifecycle: its CLI includes a background
    // self-updater, but does not expose a stable public latest-version feed.
    return {
      updateSource: 'provider_cli',
      updateCheckedAt: new Date().toISOString()
    };
  }

  return {
    updateSource: 'none',
    updateCheckedAt: new Date().toISOString()
  };
}

export async function enrichRuntimeUpdates(runtimes: RuntimeEngine[]): Promise<RuntimeEngine[]> {
  return Promise.all(runtimes.map(async runtime => ({
    ...runtime,
    ...(await checkRuntimeUpdate(runtime))
  })));
}
