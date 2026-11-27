import type { Project, ProjectResource, ProjectResourceApp } from '../models/index.js';
import { parseRepoRef } from './githubIssueMapping.js';
import { MONOREPO_APPS, type MonorepoAppId } from './monorepoLayout.js';

export { MONOREPO_APPS, type MonorepoAppId };

/**
 * The two apps of an Alpha monorepo: a frontend in `apps/web` and a backend in
 * `apps/api`, each a complete project with its own package.json and lockfile.
 *
 * Everything that hosts, tests or previews one of them needs the same three
 * facts -- which folder, which role, which name on Render or Vercel -- so they
 * are answered here once. A repository without apps (single or paired) is a
 * single-app repository and keeps every name it had before monorepos existed.
 */

/** Backend first, the order hosting sets them up in: the frontend's API URL needs the backend to exist. */
export const MONOREPO_APP_IDS: readonly MonorepoAppId[] = ['api', 'web'];

export function parseMonorepoApp(value: unknown): MonorepoAppId | undefined {
  return value === 'web' || value === 'api' ? value : undefined;
}

export function otherMonorepoApp(app: MonorepoAppId): MonorepoAppId {
  return app === 'web' ? 'api' : 'web';
}

/**
 * The name an app is hosted under on Render and Vercel: the repository's own
 * name for a single-app repository, `<name>-web` or `<name>-api` for a
 * monorepo app. Render adds `-uat` for its uat service either way.
 */
export function hostedName(repo: string, app?: MonorepoAppId): string {
  const name = repo.includes('/') ? repo.split('/')[1] : repo;
  return app ? `${name}-${app}` : name;
}

/** The records a freshly scaffolded monorepo stores on its project resource. */
export function monorepoResourceApps(frontendStack: string, backendStack: string): ProjectResourceApp[] {
  return [
    { id: 'web', role: 'frontend', stack: frontendStack, path: MONOREPO_APPS.web.path },
    { id: 'api', role: 'backend', stack: backendStack, path: MONOREPO_APPS.api.path }
  ];
}

/** The `github_repo` resource on `project` that is exactly `owner/name`, if any. */
export function repoResource(project: Project | null | undefined, repo: string): ProjectResource | undefined {
  if (!project) return undefined;
  const wanted = repo.toLowerCase();
  return project.resources?.find(resource => {
    if (resource.type !== 'github_repo') return false;
    const ref = parseRepoRef(resource.pathOrUrl);
    return ref ? `${ref.owner}/${ref.repo}`.toLowerCase() === wanted : false;
  });
}

/** A monorepo resource's apps; empty for every other repository. */
export function resourceApps(resource: ProjectResource | null | undefined): ProjectResourceApp[] {
  return Array.isArray(resource?.apps) ? resource!.apps.filter(app => parseMonorepoApp(app?.id)) : [];
}

/** The app `app` of `repo` on `project`, when that repository is a monorepo that has it. */
export function monorepoApp(project: Project | null | undefined, repo: string, app: MonorepoAppId): ProjectResourceApp | undefined {
  return resourceApps(repoResource(project, repo)).find(entry => entry.id === app);
}

/**
 * Each hosted thing in `repo`: one entry without an app for a single-app
 * repository, one per app for a monorepo. What a caller iterates over when it
 * used to assume "one repository, one deployment".
 */
export function hostedTargetsFor(project: Project | null | undefined, repo: string): Array<{ app?: MonorepoAppId; stack?: string }> {
  const resource = repoResource(project, repo);
  const apps = resourceApps(resource);
  if (apps.length) return apps.map(app => ({ app: app.id, stack: app.stack }));
  return [{ ...(resource?.stack ? { stack: resource.stack } : {}) }];
}
