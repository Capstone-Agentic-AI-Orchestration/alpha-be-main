/**
 * Where each app of an Alpha monorepo lives. Dependency-free so the scaffold
 * builder can share it with hosting without importing either's world; the
 * rest of the monorepo vocabulary is in `monorepoApps.ts`.
 */
export type MonorepoAppId = 'web' | 'api';

export const MONOREPO_APPS: Record<MonorepoAppId, { role: 'frontend' | 'backend'; path: string }> = {
  web: { role: 'frontend', path: 'apps/web' },
  api: { role: 'backend', path: 'apps/api' }
};
