import fs from 'node:fs';
import path from 'node:path';
import { MAX_PROJECT_CONTEXT_CHARS } from './orchestrationContract.js';
import { projectBrief } from './productPicture.js';
import { describeRepositoryExecution, packageManagerFor, readManifest } from './repositoryExecution.js';

/**
 * Standing facts the planner and every specialist receive about a project's code.
 *
 * Two sources: a short description of the stack Alpha detects from each
 * repository's manifests, and the project's description in Alpha. The team's own
 * notes (AGENTS.md) are repository memory, which travels separately and comes
 * first in every agent's context; see repositoryMemory.ts. Everything here
 * narrows how work is done; it never widens what the build may change.
 */

const PACKAGE_LABELS: ReadonlyArray<[string, string]> = [
  ['next', 'Next.js'], ['react-native', 'React Native'], ['expo', 'Expo'], ['react', 'React'], ['vue', 'Vue'],
  ['svelte', 'Svelte'], ['@angular/core', 'Angular'], ['express', 'Express'], ['fastify', 'Fastify'],
  ['@nestjs/core', 'NestJS'], ['vite', 'Vite'], ['typescript', 'TypeScript'], ['tailwindcss', 'Tailwind CSS'],
  ['vitest', 'Vitest'], ['jest', 'Jest'], ['mocha', 'Mocha'], ['@playwright/test', 'Playwright'], ['cypress', 'Cypress'],
  ['@testing-library/react', 'React Testing Library'], ['prisma', 'Prisma'], ['drizzle-orm', 'Drizzle ORM'],
  ['@supabase/supabase-js', 'Supabase'], ['zod', 'Zod'], ['redux', 'Redux'], ['@reduxjs/toolkit', 'Redux Toolkit'],
  ['zustand', 'Zustand'], ['@tanstack/react-query', 'TanStack Query'], ['react-router-dom', 'React Router']
];

/** One line naming the frameworks, tools, and package manager a repository uses. */
export function detectRepositoryStack(repositoryDir: string): string | undefined {
  const facts: string[] = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>; type?: string;
    };
    const versions = { ...(manifest.devDependencies ?? {}), ...(manifest.dependencies ?? {}) };
    for (const [name, label] of PACKAGE_LABELS) {
      if (versions[name]) facts.push(label + ' ' + String(versions[name]).replace(/^[\^~]/, ''));
    }
    if (manifest.type === 'module') facts.push('ES modules');
  } catch { /* No package.json: other ecosystems below. */ }
  const has = (name: string) => fs.existsSync(path.join(repositoryDir, name));
  const manifest = readManifest(repositoryDir);
  if (manifest && (manifest.packageManager || ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb'].some(has))) {
    facts.push(packageManagerFor(repositoryDir, manifest));
  }
  if (has('pyproject.toml') || has('requirements.txt')) facts.push('Python');
  if (has('go.mod')) facts.push('Go');
  if (has('Cargo.toml')) facts.push('Rust');
  return facts.length ? facts.join(', ') : undefined;
}

export function composeProjectContext(input: {
  description?: string;
  repositories: ReadonlyArray<{ repository: string; dir: string }>;
}): string {
  const sections: string[] = [];
  for (const { repository, dir } of input.repositories) {
    const stack = detectRepositoryStack(dir);
    const execution = readManifest(dir) ? describeRepositoryExecution(dir) : '';
    if (!stack && !execution) continue;
    sections.push([
      '## ' + repository,
      stack ? 'Detected stack: ' + stack + '.' : '',
      execution
    ].filter(Boolean).join('\n'));
  }
  const description = projectBrief(input.description);
  const context = [description ? 'Project: ' + description : '', ...sections].filter(Boolean).join('\n\n');
  return context.length > MAX_PROJECT_CONTEXT_CHARS ? context.slice(0, MAX_PROJECT_CONTEXT_CHARS - 14).trimEnd() + '\n… (shortened)' : context;
}
