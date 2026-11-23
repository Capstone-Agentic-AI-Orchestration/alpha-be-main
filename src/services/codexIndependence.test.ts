import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Alpha's Codex runtime must never depend on a gateway on the operator's machine.
 *
 * Alpha once re-applied the `openai_base_url` and `model_catalog_json` that
 * OpenCodex writes into ~/.codex/config.toml, and probed its port for models.
 * Every Codex turn then needed that gateway running: when it was stopped, a
 * chat "hello" sat on "connection refused" retries for minutes and never
 * answered, on a model Codex serves directly with its own sign-in.
 *
 * This scans the shipped source, so the dependency cannot come back through a
 * new caller, a helper in another file, or a hardcoded gateway port.
 */
const SRC = path.resolve(__dirname, '..');

const GATEWAY_OVERRIDE = [
  // A Codex `-c`/`--config` override that redirects or replaces its provider.
  /\b(openai_base_url|model_catalog_json|experimental_realtime_ws_base_url)\s*=/,
  // OpenCodex's default port, as a literal.
  /127\.0\.0\.1:10100|localhost:10100/
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

describe('Codex independence from local gateways', () => {
  it('has no gateway override or gateway port anywhere in the shipped source', () => {
    const offenders = sourceFiles(SRC).flatMap(file =>
      fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, index) =>
        GATEWAY_OVERRIDE.some(pattern => pattern.test(line))
          ? [`${path.relative(SRC, file)}:${index + 1}: ${line.trim()}`]
          : []
      )
    );
    expect(offenders).toEqual([]);
  });
});
