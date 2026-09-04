import { describe, it, expect } from 'vitest';
import {
  buildProjectScaffold,
  normalizeProjectStack,
  normalizeRepoShape,
  SUPPORTED_STACKS
} from './scaffoldBuilder.js';

const paths = (files: { path: string }[]) => files.map(f => f.path);
const read = (files: { path: string; content: string }[], p: string) =>
  files.find(f => f.path === p)?.content ?? '';

describe('normalizeProjectStack', () => {
  it('accepts canonical keys', () => {
    expect(normalizeProjectStack('nextjs')).toBe('nextjs');
    expect(normalizeProjectStack('react')).toBe('react');
    expect(normalizeProjectStack('nestjs')).toBe('nestjs');
    expect(normalizeProjectStack('nodejs')).toBe('nodejs');
  });

  it('accepts loose ids used by older payloads', () => {
    expect(normalizeProjectStack('nestjs-api')).toBe('nestjs');
    expect(normalizeProjectStack('react-app')).toBe('react');
    expect(normalizeProjectStack('Next.js')).toBe('nextjs');
  });

  it('does not mistake react-native for react', () => {
    expect(normalizeProjectStack('react-native')).toBe('nodejs');
  });

  it('falls back to nodejs for anything unrecognised', () => {
    expect(normalizeProjectStack(undefined)).toBe('nodejs');
    expect(normalizeProjectStack('')).toBe('nodejs');
    expect(normalizeProjectStack('cobol')).toBe('nodejs');
  });
});

describe('normalizeRepoShape', () => {
  it('maps catalog short ids to canonical form', () => {
    expect(normalizeRepoShape('mono')).toBe('monorepo');
    expect(normalizeRepoShape('multi')).toBe('multi-repo');
    expect(normalizeRepoShape('microservices')).toBe('microservices');
  });

  it('defaults to standalone', () => {
    expect(normalizeRepoShape(undefined)).toBe('standalone');
    expect(normalizeRepoShape('nonsense')).toBe('standalone');
  });
});

describe('buildProjectScaffold', () => {
  it('refuses shapes it cannot emit rather than quietly building a standalone repo', () => {
    // Silently downgrading would hand back a single-package repo to someone who
    // asked for a monorepo, and they would only find out after the push.
    expect(() => buildProjectScaffold({ serviceName: 'x', stack: 'nodejs', repoShape: 'mono' }))
      .toThrow(/not supported yet/i);
    expect(() => buildProjectScaffold({ serviceName: 'x', stack: 'nodejs', repoShape: 'multi' }))
      .toThrow(/not supported yet/i);
  });

  it.each(SUPPORTED_STACKS)('emits the shared baseline for %s', stack => {
    const files = buildProjectScaffold({ serviceName: 'billing-api', stack });
    const p = paths(files);

    for (const expected of [
      'README.md',
      '.gitignore',
      'package.json',
      'tsconfig.json',
      'jest.config.ts',
      'eslint.config.mjs',
      '.env.example',
      'src/index.ts',
      'tests/README.md',
      'tests/unit/index.spec.ts'
    ]) {
      expect(p).toContain(expected);
    }
  });

  it('emits no duplicate paths', () => {
    for (const stack of SUPPORTED_STACKS) {
      const p = paths(buildProjectScaffold({ serviceName: 'svc', stack, includeDocker: true }));
      expect(new Set(p).size).toBe(p.length);
    }
  });

  it('writes a package.json that parses and carries the expected scripts', () => {
    const files = buildProjectScaffold({ serviceName: 'Billing API', stack: 'nodejs' });
    const pkg = JSON.parse(read(files, 'package.json'));

    expect(pkg.name).toBe('billing-api');
    expect(pkg.version).toBe('0.1.0');
    expect(Object.keys(pkg.scripts)).toEqual(
      expect.arrayContaining(['build', 'start', 'dev', 'test', 'typecheck', 'lint'])
    );
    // Pinned, not floating — a '*' range makes the scaffold unreproducible.
    for (const range of Object.values(pkg.devDependencies) as string[]) {
      expect(range).not.toBe('*');
    }
  });

  it('slugifies awkward service names into a valid package name', () => {
    const nameFor = (serviceName: string) =>
      JSON.parse(read(buildProjectScaffold({ serviceName, stack: 'nodejs' }), 'package.json')).name;

    expect(nameFor('  Billing   API!! ')).toBe('billing-api');
    expect(nameFor('---')).toBe('service');
    expect(nameFor('!!!')).toBe('service');
  });

  it('gives nextjs a root layout, a page and no build tsconfig', () => {
    const files = buildProjectScaffold({ serviceName: 'storefront', stack: 'nextjs' });
    const p = paths(files);

    expect(p).toContain('src/app/layout.tsx');
    expect(p).toContain('src/app/page.tsx');
    expect(p).toContain('next.config.ts');
    // next build runs its own pipeline; a src-only emit config would be dead weight.
    expect(p).not.toContain('tsconfig.build.json');

    const pkg = JSON.parse(read(files, 'package.json'));
    expect(pkg.scripts.build).toBe('next build');
    expect(pkg.dependencies.next).toBeDefined();
  });

  it('gives nestjs a module, a main and the peer deps tsc needs', () => {
    const files = buildProjectScaffold({ serviceName: 'orders', stack: 'nestjs' });
    const p = paths(files);

    expect(p).toContain('src/app.module.ts');
    expect(p).toContain('src/main.ts');
    expect(p).toContain('tsconfig.build.json');

    const pkg = JSON.parse(read(files, 'package.json'));
    // Without these two, tsc cannot resolve NestJS's own type imports.
    expect(pkg.dependencies['reflect-metadata']).toBeDefined();
    expect(pkg.dependencies.rxjs).toBeDefined();
  });

  it('gives react a component and its own spec', () => {
    const files = buildProjectScaffold({ serviceName: 'dashboard', stack: 'react' });
    const p = paths(files);

    expect(p).toContain('src/App.tsx');
    expect(p).toContain('tests/unit/App.spec.tsx');
    expect(read(files, 'src/App.tsx')).toContain('dashboard');
  });

  it('sets jsx and DOM lib only for frontend stacks', () => {
    const front = JSON.parse(read(buildProjectScaffold({ serviceName: 's', stack: 'react' }), 'tsconfig.json'));
    const back = JSON.parse(read(buildProjectScaffold({ serviceName: 's', stack: 'nodejs' }), 'tsconfig.json'));

    expect(front.compilerOptions.jsx).toBe('react-jsx');
    expect(front.compilerOptions.lib).toContain('DOM');
    expect(back.compilerOptions.jsx).toBeUndefined();
    expect(back.compilerOptions.lib).not.toContain('DOM');
  });

  it('includes Docker files only when asked, with a stack-correct entrypoint', () => {
    const without = paths(buildProjectScaffold({ serviceName: 's', stack: 'nodejs' }));
    expect(without).not.toContain('Dockerfile');

    const node = buildProjectScaffold({ serviceName: 's', stack: 'nodejs', includeDocker: true });
    expect(paths(node)).toContain('Dockerfile');
    expect(paths(node)).toContain('.dockerignore');
    expect(read(node, 'Dockerfile')).toContain('dist/index.js');

    const nest = buildProjectScaffold({ serviceName: 's', stack: 'nestjs', includeDocker: true });
    expect(read(nest, 'Dockerfile')).toContain('dist/main.js');
  });

  it('writes a README carrying the service name and the description', () => {
    const files = buildProjectScaffold({
      serviceName: 'payments',
      stack: 'nodejs',
      description: 'Handles card capture and refunds.'
    });
    const readme = read(files, 'README.md');

    expect(readme).toContain('# payments');
    expect(readme).toContain('Handles card capture and refunds.');
  });

  it('still writes a usable README when no description is given', () => {
    const readme = read(buildProjectScaffold({ serviceName: 'payments', stack: 'nodejs' }), 'README.md');
    expect(readme).toContain('# payments');
    expect(readme).toContain('npm install');
  });

  it('never emits an empty file', () => {
    for (const stack of SUPPORTED_STACKS) {
      for (const file of buildProjectScaffold({ serviceName: 'svc', stack, includeDocker: true })) {
        expect(file.content.trim().length, `${stack}: ${file.path}`).toBeGreaterThan(0);
      }
    }
  });

  it('emits no CI configuration — that is a separate concern', () => {
    for (const stack of SUPPORTED_STACKS) {
      const p = paths(buildProjectScaffold({ serviceName: 'svc', stack, includeDocker: true }));
      expect(p).not.toContain('sonar-project.properties');
      expect(p.some(f => f.startsWith('.github/'))).toBe(false);
    }
  });
});
