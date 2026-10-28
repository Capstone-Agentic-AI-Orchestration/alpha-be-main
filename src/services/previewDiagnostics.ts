import type { LocalPreview } from './localPreviewService.js';

/** Isolation blocks are not proof of an application bug. Report observed console/load/HTTP failures. */
export function hasPreviewErrors(record: Pick<LocalPreview, 'browserDiagnostics'>): boolean {
  return Boolean(record.browserDiagnostics?.some(entry =>
    (entry.kind === 'console' && entry.message.startsWith('Error:')) || entry.kind === 'load' ||
    (entry.kind === 'request' && /\bHTTP [45]\d\d\b/.test(entry.message))));
}
