import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function localBaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase())) return undefined;
    return value.trim().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

function rootTomlString(config: string, key: string): string | undefined {
  const match = config.match(new RegExp(`^\\s*${key}\\s*=\\s*(["'])(.*?)\\1\\s*(?:#.*)?$`, 'im'));
  if (!match) return undefined;
  if (match[1] === "'") return match[2];
  try {
    return JSON.parse(`"${match[2]}"`) as string;
  } catch {
    return undefined;
  }
}

function catalogPathInsideCodexHome(config: string, home: string): string | undefined {
  const configuredPath = rootTomlString(config, 'model_catalog_json');
  if (!configuredPath) return undefined;

  const expanded = configuredPath.replace(/^~(?=$|[\\/])/, os.homedir());
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded);
  try {
    const realHome = fs.realpathSync(home);
    const realCatalog = fs.realpathSync(absolute);
    const relative = path.relative(realHome, realCatalog);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    if (!fs.statSync(realCatalog).isFile()) return undefined;
    return realCatalog;
  } catch {
    return undefined;
  }
}

/**
 * Keep Codex isolated from the operator's full config, while supplying the
 * local gateway and its current native model metadata for models Alpha found
 * in that same catalog.
 */
export function codexModelConfigArgs(
  modelName: string | undefined,
  endpoint: string | undefined,
  options: { home?: string; config?: string } = {}
): string[] {
  if (!modelName) return [];
  const home = options.home ?? codexHome();
  let config = options.config;
  if (config === undefined) {
    try {
      config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    } catch {
      return [];
    }
  }

  /**
   * The scanned gateway first, then the operator's own `openai_base_url`.
   *
   * The runtime scan gives the gateway 1.5s to list its models. When it is
   * slow, the scan falls back to Codex's model cache and records no endpoint —
   * and every Codex turn until the next scan ran without the gateway, so a
   * gateway-only model such as `gpt-6-astra` answered with nothing but
   * "Model metadata ... not found". The configured local gateway is the same
   * one the scan would have found, so it is used when the scan missed it.
   */
  const baseUrl = localBaseUrl(endpoint) ?? localBaseUrl(rootTomlString(config, 'openai_base_url'));
  const catalogPath = catalogPathInsideCodexHome(config, home);
  if (!baseUrl || !catalogPath) return [];

  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { models?: unknown };
    const modelExists = Array.isArray(catalog.models) && catalog.models.some(model =>
      Boolean(model && typeof model === 'object' && 'slug' in model && (model as { slug?: unknown }).slug === modelName)
    );
    if (!modelExists) return [];
  } catch {
    return [];
  }

  return [
    '--config', `openai_base_url=${JSON.stringify(baseUrl)}`,
    '--config', `model_catalog_json=${JSON.stringify(catalogPath)}`
  ];
}
