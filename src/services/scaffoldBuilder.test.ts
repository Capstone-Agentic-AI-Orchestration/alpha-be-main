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
      'tests/README.md'
    ]) {
      expect(p).toContain(expected);
    }
  });

  /**
   * A service entry point, for the stacks that are services.
   *
   * `src/index.ts` exports a SERVICE_NAME constant and the spec asserts it.
   * This used to be part of the baseline for every stack including react —
   * which is how react came to be a Node program with an unmounted App.tsx
   * beside it: its own toolchain treated that file as the program. A browser
   * app's entry point is `src/main.tsx`, and it is checked in
   * scaffoldRunnable.test.ts along with the rest of what makes a stack a web
   * application rather than a service.
   */
  it.each(SUPPORTED_STACKS.filter(s => s !== 'react'))(
    'emits a service entry point for %s',
    stack => {
      const p = paths(buildProjectScaffold({ serviceName: 'billing-api', stack }));
      expect(p).toContain('src/index.ts');
      expect(p).toContain('tests/unit/index.spec.ts');
    }
  );

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

  it('keeps nestjs past the multer release its framework pins', () => {
    const nest = JSON.parse(read(buildProjectScaffold({ serviceName: 'orders', stack: 'nestjs' }), 'package.json'));
    const node = JSON.parse(read(buildProjectScaffold({ serviceName: 'orders', stack: 'nodejs' }), 'package.json'));

    // Without it, npm audit --audit-level=high fails the generated CI on the first push.
    expect(nest.overrides).toEqual({ multer: '^2.5.0' });
    expect(node.overrides).toBeUndefined();
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
      const p = buildProjectScaffold({ serviceName: 'svc', stack, includeDocker: true }).map(f => f.path);
      expect(p).not.toContain('sonar-project.properties');
      expect(p.some(f => f.startsWith('.github/'))).toBe(false);
    }
  });

  describe('nodejs is a real HTTP server', () => {
    it('has its own app module, separate from the entry point that listens', () => {
      const files = buildProjectScaffold({ serviceName: 'billing-api', stack: 'nodejs' });
      const p = paths(files);
      expect(p).toContain('src/app.ts');
      expect(p).toContain('src/index.ts');

      const app = read(files, 'src/app.ts');
      expect(app).toContain("app.get('/health'");
      expect(app).toContain("status: 'ok'");
      expect(app).toContain('cors(');
      expect(app).toContain('CORS_ORIGINS');

      const index = read(files, 'src/index.ts');
      expect(index).toContain('app.listen(');
      expect(index).not.toContain("'/health'");
    });

    it('tests /health with supertest against the app, not a bound port', () => {
      const spec = read(buildProjectScaffold({ serviceName: 'billing-api', stack: 'nodejs' }), 'tests/unit/index.spec.ts');
      expect(spec).toContain("import request from 'supertest'");
      expect(spec).toContain("from '../../src/app'");
      expect(spec).toContain("request(app).get('/health')");
    });

    it('carries express and cors as real dependencies, pinned', () => {
      const pkg = JSON.parse(read(buildProjectScaffold({ serviceName: 'billing-api', stack: 'nodejs' }), 'package.json'));
      expect(pkg.dependencies.express).toBeDefined();
      expect(pkg.dependencies.cors).toBeDefined();
      expect(pkg.devDependencies.supertest).toBeDefined();
      for (const range of [pkg.dependencies.express, pkg.dependencies.cors, pkg.devDependencies.supertest]) {
        expect(range).not.toBe('*');
      }
    });
  });

  describe('nestjs listens for real traffic', () => {
    it('gets a health controller and CORS from CORS_ORIGINS', () => {
      const files = buildProjectScaffold({ serviceName: 'orders', stack: 'nestjs' });
      const p = paths(files);
      expect(p).toContain('src/app.controller.ts');
      expect(read(files, 'src/app.controller.ts')).toContain("@Get('health')");

      const main = read(files, 'src/main.ts');
      expect(main).toContain('process.env.PORT');
      expect(main).toContain('CORS_ORIGINS');
      expect(main).toContain('cors: { origin: corsOrigins() }');
    });

    it('has a start:prod script', () => {
      const pkg = JSON.parse(read(buildProjectScaffold({ serviceName: 'orders', stack: 'nestjs' }), 'package.json'));
      expect(pkg.scripts['start:prod']).toBeTruthy();
    });
  });

  describe('frontend API URLs use the right prefix for their bundler', () => {
    it('react reads VITE_API_URL, never NEXT_PUBLIC_*', () => {
      const env = read(buildProjectScaffold({ serviceName: 'dashboard', stack: 'react' }), '.env.example');
      expect(env).toContain('VITE_API_URL=http://localhost:3000');
      expect(env).not.toContain('NEXT_PUBLIC_');
    });

    it('nextjs reads NEXT_PUBLIC_API_URL and runs on 3001 locally', () => {
      const files = buildProjectScaffold({ serviceName: 'storefront', stack: 'nextjs' });
      expect(read(files, '.env.example')).toContain('NEXT_PUBLIC_API_URL=http://localhost:3000');

      const pkg = JSON.parse(read(files, 'package.json'));
      expect(pkg.scripts.dev).toContain('-p 3001');
      expect(pkg.scripts.start).toContain('-p 3001');
    });
  });

  describe('a backend’s .env.example', () => {
    it.each(['nodejs', 'nestjs'] as const)('points CORS_ORIGINS at both frontend dev servers for %s', stack => {
      const env = read(buildProjectScaffold({ serviceName: 'svc', stack }), '.env.example');
      expect(env).toContain('PORT=3000');
      expect(env).toContain('CORS_ORIGINS=http://localhost:5173,http://localhost:3001');
    });
  });
});
