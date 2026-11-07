// ─── Scaffold builder ─────────────────────────────────────────────────────────
//
// Generates a starting project structure — an array of { path, content } tuples
// ready to be written to disk and pushed to a freshly-created GitHub repository.
//
// CI is deliberately not part of this: there is no sonar-project.properties
// here and no workflow YAML (ciWorkflows.ts adds the CI caller). What is left
// is an ordinary TypeScript project a developer would recognise — build, test,
// lint and typecheck scripts that work the moment `npm install` finishes.
//
// A root README is generated here rather than relying on GitHub's `auto_init`,
// because repositories created from a source directory never get that.

export interface ScaffoldFile {
  path: string;
  content: string;
}

export type CanonicalRepoShape = 'standalone' | 'monorepo' | 'microservices' | 'multi-repo';

export type CanonicalStack = 'nestjs' | 'nodejs' | 'nextjs' | 'react';

/** Every stack the scaffold can emit, in the order the UI should offer them. */
export const SUPPORTED_STACKS: CanonicalStack[] = ['nodejs', 'nestjs', 'nextjs', 'react'];

/**
 * Accept loose stack ids ('nestjs-api', 'react-app') as well as canonical keys.
 * Anything unrecognised becomes 'nodejs', which is the least surprising default:
 * a plain TypeScript service with no framework assumptions.
 */
export function normalizeProjectStack(stack: string | null | undefined): CanonicalStack {
  const normalized = (stack ?? '').toLowerCase();

  if (normalized.includes('next')) return 'nextjs';
  if (normalized.includes('react') && !normalized.includes('react-native')) return 'react';
  if (normalized.includes('nest')) return 'nestjs';
  return 'nodejs';
}

/** Map short shape ids to canonical form. Unknown values fall back to standalone. */
export function normalizeRepoShape(repoShape: string | null | undefined): CanonicalRepoShape {
  switch (repoShape) {
    case 'mono':
    case 'monorepo':
      return 'monorepo';
    case 'multi':
    case 'multi-repo':
      return 'multi-repo';
    case 'microservices':
      return 'microservices';
    default:
      return 'standalone';
  }
}

export interface BuildScaffoldOptions {
  /** Human-readable service name. Also seeds the package name and README title. */
  serviceName: string;
  stack: string;
  includeDocker?: boolean;
  nodeVersion?: string;
  repoShape?: string;
  /** Optional prose for the README, usually the project description. */
  description?: string;
}

/**
 * Convert a human-readable service name to a valid npm package name.
 *
 * The separator trim is a loop rather than /^-+|-+$/ because that pattern
 * backtracks super-linearly on a name that is mostly punctuation.
 */
function toPackageName(name: string): string {
  const slug = name.toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-');

  let start = 0;
  let end = slug.length;
  while (start < end && slug[start] === '-') start += 1;
  while (end > start && slug[end - 1] === '-') end -= 1;

  return slug.slice(start, end) || 'service';
}

// ─── Shared file builders (all stacks) ────────────────────────────────────────

function buildGitignore(): string {
  return [
    'node_modules/',
    'dist/',
    'build/',
    '.env',
    '.env.local',
    '.env.*.local',
    'coverage/',
    '*.log',
    'npm-debug.log*',
    '.DS_Store',
    '.turbo/',
    '.next/',
    'out/',
    ''
  ].join('\n');
}

// Pinned ranges rather than '*'. A scaffold with floating majors stops being
// reproducible the moment one of them ships a breaking release — ESLint 9
// dropping --ext and .eslintrc is the cautionary example.
const SCAFFOLD_DEV_DEPENDENCIES: Record<string, string> = {
  typescript: '^5.6.3',
  eslint: '^9.17.0',
  'typescript-eslint': '^8.18.0',
  jest: '^29.7.0',
  'ts-jest': '^29.2.5',
  '@types/jest': '^29.5.14',
  '@types/node': '^22.10.0',
  // Every stack's jest.config.ts is TypeScript, and jest loads a TS config
  // through ts-node. Next.js lacked it, so its tests could not start at all.
  'ts-node': '^10.9.2'
};

/**
 * What the generated CI runs for coverage.
 *
 * `backend-tests.yml` in alphaorch-workflow runs `npm run test:cov` and reads
 * `coverage/coverage-summary.json`; the json-summary reporter writes exactly
 * that, and `text` keeps a readable table in the log. Frontend CI calls jest
 * with its own coverage flags, so the script only has to exist for backends,
 * but every stack gets it so `npm run test:cov` means the same thing anywhere.
 */
const COVERAGE_SCRIPT = 'jest --coverage --coverageReporters=json-summary --coverageReporters=text';

/**
 * Versions forced beneath a framework that pins a vulnerable release.
 *
 * The newest NestJS 11 `@nestjs/platform-express` (11.2.8) pins multer 2.4.0,
 * which carries a high-severity advisory (GHSA-q7qp-rjg7-q26m). The generated
 * CI runs `npm audit --audit-level=high`, so every new NestJS repository failed
 * its first push. multer 2.5.0 fixes it within the same major.
 */
const NEST_OVERRIDES: Record<string, string> = { multer: '^2.5.0' };

/**
 * The scaffolded backend's default port, everywhere one is quoted.
 *
 * A frontend's `.env.example` and a backend's CORS allowlist have to agree on
 * this without importing from one another -- they are two separate
 * repositories the moment they are pushed -- so both read it from here.
 */
const BACKEND_DEFAULT_PORT = 3000;
/** Vite's own default, kept explicit so the frontend and backend never guess the same port. */
const REACT_DEV_PORT = 5173;
/** One above the backend's, so `next dev`/`next start` do not collide with it locally. */
const NEXTJS_DEV_PORT = 3001;

function buildPackageJson(packageName: string, stack: CanonicalStack): string {
  let scripts: Record<string, string>;

  if (stack === 'nextjs') {
    scripts = {
      build: 'next build',
      // -p 3001: the backend stacks default to 3000 (see BACKEND_DEFAULT_PORT),
      // and a frontend that ran on the same port could never be developed
      // against a local backend at the same time.
      start: `next start -p ${NEXTJS_DEV_PORT}`,
      dev: `next dev -p ${NEXTJS_DEV_PORT}`,
      test: 'jest',
      'test:cov': COVERAGE_SCRIPT,
      typecheck: 'tsc --noEmit',
      lint: 'eslint src tests'
    };
  } else if (stack === 'react') {
    /**
     * A browser toolchain, because this is the stack people pick when they
     * want a web app.
     *
     * It used to fall through to the Node defaults below — `tsc` to `dist/`,
     * `node dist/index.js` to start, `ts-node src/index.ts` to develop. That
     * builds and runs and is not a web application by any definition.
     */
    scripts = {
      build: 'tsc --noEmit && vite build',
      start: 'vite preview',
      dev: 'vite',
      test: 'jest',
      'test:cov': COVERAGE_SCRIPT,
      typecheck: 'tsc --noEmit',
      lint: 'eslint src tests'
    };
  } else if (stack === 'nestjs') {
    scripts = {
      build: 'tsc -p tsconfig.build.json',
      start: 'node dist/main.js',
      // Nest CLI's own convention. Identical to `start` here -- there is no
      // separate production build step yet -- but a host that runs
      // `npm run start:prod` (as most Nest deploy guides assume) finds it.
      'start:prod': 'node dist/main.js',
      dev: 'ts-node src/main.ts',
      test: 'jest',
      'test:cov': COVERAGE_SCRIPT,
      typecheck: 'tsc --noEmit',
      lint: 'eslint src tests'
    };
  } else {
    scripts = {
      build: 'tsc -p tsconfig.build.json',
      start: 'node dist/index.js',
      dev: 'ts-node src/index.ts',
      test: 'jest',
      'test:cov': COVERAGE_SCRIPT,
      typecheck: 'tsc --noEmit',
      lint: 'eslint src tests'
    };
  }

  const pkg = {
    name: packageName,
    version: '0.1.0',
    private: true,
    scripts,
    dependencies: {} as Record<string, string>,
    devDependencies: { ...SCAFFOLD_DEV_DEPENDENCIES } as Record<string, string>,
    ...(stack === 'nestjs' ? { overrides: { ...NEST_OVERRIDES } } : {})
  };

  if (stack === 'nestjs') {
    pkg.dependencies['@nestjs/common'] = '^11.0.0';
    pkg.dependencies['@nestjs/core'] = '^11.0.0';
    pkg.dependencies['@nestjs/platform-express'] = '^11.0.0';
    // Peer dependencies of the framework — without them tsc cannot resolve
    // NestJS's own type imports and the build fails on a fresh clone.
    pkg.dependencies['reflect-metadata'] = '^0.2.2';
    pkg.dependencies['rxjs'] = '^7.8.1';
    pkg.devDependencies['@nestjs/testing'] = '^11.0.0';
  }

  if (stack === 'nextjs' || stack === 'react') {
    pkg.dependencies['react'] = '^19.0.0';
    pkg.dependencies['react-dom'] = '^19.0.0';
    pkg.devDependencies['@types/react'] = '^19.0.0';
    pkg.devDependencies['@types/react-dom'] = '^19.0.0';
  }

  if (stack === 'react') {
    // Next brings its own bundler; a plain React app has none until given one.
    pkg.devDependencies['vite'] = '^6.0.0';
    pkg.devDependencies['@vitejs/plugin-react'] = '^4.3.4';
  }

  if (stack === 'nextjs') {
    // 16.3.6+: earlier releases depend on a postcss with a high-severity
    // advisory (GHSA-qx2v-qp2m-jg93), which fails the generated CI's
    // `npm audit --audit-level=high` on the first push.
    pkg.dependencies['next'] = '^16.3.6';
  }

  if (stack === 'nodejs') {
    // A plain `nodejs` stack used to compile to a command-line program with
    // nothing listening on a port -- unrunnable as an API, and unhostable on
    // Render, which health-checks over HTTP. Express is the least surprising
    // choice for the stack labelled "Node.js API".
    pkg.dependencies['express'] = '^4.21.2';
    pkg.dependencies['cors'] = '^2.8.5';
    pkg.devDependencies['@types/express'] = '^4.17.21';
    pkg.devDependencies['@types/cors'] = '^2.8.17';
    pkg.devDependencies['supertest'] = '^7.1.0';
    pkg.devDependencies['@types/supertest'] = '^6.0.2';
  }

  return JSON.stringify(pkg, null, 2) + '\n';
}

// Base tsconfig covers src AND tests so `tsc --noEmit` type-checks the suites.
// Emit settings live in tsconfig.build.json so tests never reach dist.
function buildTsConfig(stack: CanonicalStack): string {
  const isFrontend = stack === 'nextjs' || stack === 'react';

  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: isFrontend ? 'ESNext' : 'NodeNext',
      moduleResolution: isFrontend ? 'bundler' : 'NodeNext',
      strict: true,
      ...(isFrontend ? { jsx: 'react-jsx' } : {}),
      /**
       * Nest's own decorators (`@Module`, `@Controller`, `@Get`, ...) are
       * written against the legacy `experimentalDecorators` signatures, not
       * the TC39 Stage 3 ones TypeScript now applies by default. A class
       * decorator like `@Module()` happens to type-check under either, which
       * is how this went unnoticed until the first method decorator
       * (`@Get()`) failed with "Unable to resolve signature of method
       * decorator" -- the two proposals shape a method decorator
       * differently. `emitDecoratorMetadata` alongside it is what lets
       * Nest's dependency injection read constructor parameter types at
       * runtime.
       */
      ...(stack === 'nestjs' ? { experimentalDecorators: true, emitDecoratorMetadata: true } : {}),
      lib: isFrontend ? ['ES2022', 'DOM'] : ['ES2022'],
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true
    },
    include: ['src', 'tests'],
    exclude: ['node_modules', 'dist']
  };

  return JSON.stringify(config, null, 2) + '\n';
}

function buildBuildTsConfig(): string {
  return (
    JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: { rootDir: 'src', outDir: 'dist' },
        include: ['src'],
        exclude: ['node_modules', 'dist']
      },
      null,
      2
    ) + '\n'
  );
}

function buildJestConfig(): string {
  return [
    "import type { Config } from 'jest';",
    '',
    'const config: Config = {',
    "  preset: 'ts-jest',",
    "  testEnvironment: 'node',",
    '  testMatch: [',
    "    '**/*.spec.ts',",
    "    '**/*.test.ts',",
    "    '**/*.spec.tsx',",
    "    '**/*.test.tsx'",
    '  ],',
    '  /**',
    "   * tsconfig's `moduleResolution: NodeNext` requires every relative import",
    "   * to spell out its extension -- `./app.module.js` -- so the same code",
    '   * resolves under real Node. ts-jest compiles to CommonJS underneath, and',
    "   * Jest's own resolver looks for a literal `app.module.js` there and never",
    '   * finds one, since only `app.module.ts` exists on disk. Stripping the',
    '   * extension before resolution is what makes both true at once.',
    '   */',
    '  moduleNameMapper: {',
    "    '^(\\\\.{1,2}/.*)\\\\.js$': '$1'",
    '  }',
    '};',
    '',
    'export default config;',
    ''
  ].join('\n');
}

function buildEntryPoint(serviceName: string): string {
  return `export const SERVICE_NAME = '${serviceName}';\n`;
}

function buildEntrySpec(serviceName: string, importPath = './index'): string {
  return [
    `import { SERVICE_NAME } from '${importPath}';`,
    '',
    `describe('${serviceName}', () => {`,
    "  it('exports SERVICE_NAME', () => {",
    `    expect(SERVICE_NAME).toBe('${serviceName}');`,
    '  });',
    '});',
    ''
  ].join('\n');
}

// ─── Node.js (Express) ────────────────────────────────────────────────────────
//
// The app (routes and middleware) is a separate module from the entry point
// that listens. `tests/unit/index.spec.ts` imports the app to exercise it with
// supertest; importing `src/index.ts` instead would bind a real port every
// time the test file loaded, on whatever `PORT` happened to be set, and every
// suite that imported it in the same run would fight over that port.

/** `CORS_ORIGINS`, comma separated, trimmed, blanks dropped. */
function buildNodeCorsOriginsHelper(): string {
  return [
    '/** Origins allowed to call this API, from the comma-separated CORS_ORIGINS. */',
    'function corsOrigins(): string[] {',
    "  return (process.env.CORS_ORIGINS ?? '')",
    "    .split(',')",
    '    .map(origin => origin.trim())',
    '    .filter(Boolean);',
    '}'
  ].join('\n');
}

function buildNodeApp(serviceName: string): string {
  return [
    "import cors from 'cors';",
    "import express from 'express';",
    "import type { Express } from 'express';",
    '',
    `export const SERVICE_NAME = '${serviceName}';`,
    '',
    buildNodeCorsOriginsHelper(),
    '',
    'export const app: Express = express();',
    '',
    'app.use(cors({ origin: corsOrigins() }));',
    'app.use(express.json());',
    '',
    "// What Render polls, and how anything else knows the service is up.",
    "app.get('/health', (_req, res) => {",
    "  res.json({ status: 'ok' });",
    '});',
    ''
  ].join('\n');
}

function buildNodeIndex(): string {
  return [
    "import { app, SERVICE_NAME } from './app.js';",
    '',
    'const port = Number(process.env.PORT) || 3000;',
    '',
    'app.listen(port, () => {',
    "  console.log(`${SERVICE_NAME} listening on port ${port}`);",
    '});',
    ''
  ].join('\n');
}

function buildNodeHealthSpec(serviceName: string): string {
  return [
    "import request from 'supertest';",
    '',
    "import { app, SERVICE_NAME } from '../../src/app';",
    '',
    `describe('${serviceName}', () => {`,
    "  it('exports SERVICE_NAME', () => {",
    `    expect(SERVICE_NAME).toBe('${serviceName}');`,
    '  });',
    '',
    "  it('answers GET /health', async () => {",
    "    const res = await request(app).get('/health');",
    '',
    '    expect(res.status).toBe(200);',
    "    expect(res.body).toEqual({ status: 'ok' });",
    '  });',
    '});',
    ''
  ].join('\n');
}

// Committed inside tests/ so the folder ships with every new repo and there is
// never an empty directory git would refuse to track.
function buildTestsReadme(): string {
  return [
    '# Tests',
    '',
    'This folder is the home for all test suites in this repository.',
    '',
    '| Folder | Purpose |',
    '| ------ | ------- |',
    '| `unit/` | Unit tests. Run by `npm test`. |',
    '',
    '## Conventions',
    '',
    '- Unit test files end with `.spec.ts` or `.test.ts` (`.tsx` for React components).',
    '- Mirror the `src/` structure: `src/user/user.service.ts` is tested by `tests/unit/user/user.service.spec.ts`.',
    '- Co-located specs inside `src/` also work, but `tests/unit/` is the convention this scaffold sets up.',
    '- Keep end-to-end suites in `tests/e2e/` named `*.e2e-spec.ts` so the unit runner does not pick them up.',
    ''
  ].join('\n');
}

// ESLint 9 flat config. .eslintrc.json and the --ext flag were both removed in
// ESLint 9, so the scaffold ships eslint.config.mjs and lints via `eslint src`.
function buildEslintConfig(): string {
  return [
    "import tseslint from 'typescript-eslint';",
    '',
    'export default tseslint.config(',
    "  { ignores: ['dist/', 'coverage/', '.next/', 'out/', 'node_modules/'] },",
    '  ...tseslint.configs.recommended',
    ');',
    ''
  ].join('\n');
}

function buildEnvExample(stack: CanonicalStack): string {
  const backendUrl = `http://localhost:${BACKEND_DEFAULT_PORT}`;

  if (stack === 'react') {
    // VITE_API_URL, not NEXT_PUBLIC_API_URL: Vite only inlines variables under
    // its own prefix, so the Next.js name is invisible to `import.meta.env`
    // and every request from a Vite app would target `undefined`.
    return ['NODE_ENV=development', '', '# Base URL of the backend this frontend talks to.', `VITE_API_URL=${backendUrl}`, ''].join(
      '\n'
    );
  }
  if (stack === 'nextjs') {
    return [
      'NODE_ENV=development',
      '',
      '# Base URL of the backend this frontend talks to. NEXT_PUBLIC_ so it reaches',
      '# the browser bundle, not only server components.',
      `NEXT_PUBLIC_API_URL=${backendUrl}`,
      ''
    ].join('\n');
  }

  return [
    'NODE_ENV=development',
    `PORT=${BACKEND_DEFAULT_PORT}`,
    '',
    "# Origins permitted to call this API, comma-separated. Alpha's own scaffolded",
    '# frontends run here in development: Vite on 5173, Next.js on 3001 (moved off',
    '# 3000 so it does not collide with this backend).',
    `CORS_ORIGINS=http://localhost:${REACT_DEV_PORT},http://localhost:${NEXTJS_DEV_PORT}`,
    `FRONTEND_URL=http://localhost:${REACT_DEV_PORT}`,
    ''
  ].join('\n');
}

const SOURCE_LAYOUT_BY_STACK: Record<CanonicalStack, string> = {
  nextjs: 'src/app/      Next.js App Router pages and layouts',
  react: 'src/          React components',
  nestjs: 'src/          Application source',
  nodejs: 'src/          Application source'
};

/**
 * Root README.
 *
 * GitHub's `auto_init` writes one for repos created empty, but a repo created
 * from a source directory never passes through that path — so without this the
 * repository would land with no README at all.
 */
function buildReadme(
  serviceName: string,
  stack: CanonicalStack,
  description: string | undefined,
  includeDocker: boolean
): string {
  const sourceLine = SOURCE_LAYOUT_BY_STACK[stack];
  const structure = [sourceLine, 'tests/unit/   Unit tests'];

  return [
    `# ${serviceName}`,
    '',
    description?.trim() ? description.trim() : `${serviceName} — created with Alpha.`,
    '',
    '## Getting started',
    '',
    '```bash',
    'npm install',
    'npm run dev',
    '```',
    '',
    '## Scripts',
    '',
    '| Command | Does |',
    '| ------- | ---- |',
    '| `npm run dev` | Run locally in watch mode |',
    '| `npm run build` | Produce a production build |',
    '| `npm test` | Run the test suite |',
    '| `npm run typecheck` | Type-check without emitting |',
    '| `npm run lint` | Lint `src` and `tests` |',
    '',
    '## Layout',
    '',
    '```',
    ...structure,
    '```',
    '',
    ...(includeDocker
      ? ['## Docker', '', '```bash', `docker build -t ${toPackageName(serviceName)} .`, '```', '']
      : []),
    '---',
    '',
    '_Scaffolded by Alpha. Copy `.env.example` to `.env` before running._',
    ''
  ].join('\n');
}

// ─── NestJS ───────────────────────────────────────────────────────────────────

function buildNestAppModule(): string {
  return [
    "import { Module } from '@nestjs/common';",
    '',
    "import { AppController } from './app.controller.js';",
    '',
    '@Module({ imports: [], controllers: [AppController], providers: [] })',
    'export class AppModule {}',
    ''
  ].join('\n');
}

/** `GET /health` -- what Render polls, and how anything else knows the service is up. */
function buildNestAppController(): string {
  return [
    "import { Controller, Get } from '@nestjs/common';",
    '',
    '@Controller()',
    'export class AppController {',
    "  @Get('health')",
    '  health(): { status: string } {',
    "    return { status: 'ok' };",
    '  }',
    '}',
    ''
  ].join('\n');
}

function buildNestAppControllerSpec(): string {
  return [
    "import { Test } from '@nestjs/testing';",
    '',
    "import { AppController } from '../../src/app.controller';",
    '',
    "describe('AppController', () => {",
    "  it('answers GET /health', async () => {",
    '    const moduleRef = await Test.createTestingModule({ controllers: [AppController] }).compile();',
    '    const controller = moduleRef.get(AppController);',
    '',
    "    expect(controller.health()).toEqual({ status: 'ok' });",
    '  });',
    '});',
    ''
  ].join('\n');
}

/** `CORS_ORIGINS`, comma separated, trimmed, blanks dropped. Shared shape with the plain Node stack. */
function buildCorsOriginsHelper(): string {
  return [
    '/** Origins allowed to call this API, from the comma-separated CORS_ORIGINS. */',
    'function corsOrigins(): string[] {',
    "  return (process.env.CORS_ORIGINS ?? '')",
    "    .split(',')",
    '    .map(origin => origin.trim())',
    '    .filter(Boolean);',
    '}'
  ].join('\n');
}

function buildNestMain(): string {
  return [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module.js';",
    '',
    buildCorsOriginsHelper(),
    '',
    'async function bootstrap(): Promise<void> {',
    '  const app = await NestFactory.create(AppModule, { cors: { origin: corsOrigins() } });',
    '  await app.listen(process.env.PORT ?? 3000);',
    '}',
    '',
    'void bootstrap();',
    ''
  ].join('\n');
}

// ─── Next.js ──────────────────────────────────────────────────────────────────

function buildNextPage(serviceName: string): string {
  return [
    'export default function Home() {',
    '  return (',
    '    <main>',
    `      <h1>${serviceName}</h1>`,
    '    </main>',
    '  );',
    '}',
    ''
  ].join('\n');
}

// `next build` fails without a root layout in the App Router — unlike `next
// dev`, it is not generated for you.
function buildNextLayout(serviceName: string): string {
  return [
    "import type { ReactNode } from 'react';",
    '',
    'export const metadata = {',
    `  title: '${serviceName}'`,
    '};',
    '',
    'export default function RootLayout({ children }: { children: ReactNode }) {',
    '  return (',
    '    <html lang="en">',
    '      <body>{children}</body>',
    '    </html>',
    '  );',
    '}',
    ''
  ].join('\n');
}

function buildNextConfig(): string {
  return [
    "import type { NextConfig } from 'next';",
    '',
    'const config: NextConfig = {};',
    'export default config;',
    ''
  ].join('\n');
}

// ─── React (no bundler) ───────────────────────────────────────────────────────
//
// Deliberately bundler-free: a typed component plus a react-dom/server smoke
// test, so lint, test, build and typecheck all pass without committing the
// project to Vite or CRA. The bundler is the developer's choice to add.

/**
 * The page a browser actually loads.
 *
 * Without this the React stack produced a Node program: `dev` ran
 * `ts-node src/index.ts`, `start` ran `node dist/index.js`, and `App.tsx` sat
 * beside them with nothing mounting or serving it. It typechecked and its tests
 * passed, so nothing complained — it simply was not a web app, which is the one
 * thing someone choosing "React" is asking for.
 */
function buildViteIndexHtml(serviceName: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${serviceName}</title>`,
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    '  </body>',
    '</html>',
    ''
  ].join('\n');
}

/** Mounts the component. The missing link between App.tsx and the page. */
function buildViteMain(): string {
  return [
    "import { StrictMode } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { App } from './App';",
    '',
    "const root = document.getElementById('root');",
    'if (!root) throw new Error(\'No #root element in index.html\');',
    '',
    'createRoot(root).render(',
    '  <StrictMode>',
    '    <App />',
    '  </StrictMode>',
    ');',
    ''
  ].join('\n');
}

function buildViteConfig(): string {
  return [
    "import { defineConfig } from 'vite';",
    "import react from '@vitejs/plugin-react';",
    '',
    'export default defineConfig({',
    '  plugins: [react()],',
    '  server: {',
    '    port: 5173,',
    '    // Fail rather than silently taking the next port, so the URL printed',
    '    // is the URL that works.',
    '    strictPort: true',
    '  },',
    '  build: {',
    "    outDir: 'dist'",
    '  }',
    '});',
    ''
  ].join('\n');
}

function buildReactApp(serviceName: string): string {
  return [
    'export interface AppProps {',
    '  title?: string;',
    '}',
    '',
    `export function App({ title = '${serviceName}' }: AppProps) {`,
    '  return (',
    '    <main>',
    '      <h1>{title}</h1>',
    '    </main>',
    '  );',
    '}',
    ''
  ].join('\n');
}

function buildReactAppSpec(serviceName: string, importPath = './App'): string {
  return [
    "import { renderToString } from 'react-dom/server';",
    '',
    `import { App } from '${importPath}';`,
    '',
    "describe('App', () => {",
    "  it('renders the default title', () => {",
    `    expect(renderToString(<App />)).toContain('${serviceName}');`,
    '  });',
    '',
    "  it('renders a custom title', () => {",
    "    expect(renderToString(<App title=\"custom\" />)).toContain('custom');",
    '  });',
    '});',
    ''
  ].join('\n');
}

// ─── Docker ───────────────────────────────────────────────────────────────────

function buildDockerfile(nodeVersion: string, stack: CanonicalStack): string {
  // The scaffold ships no package-lock.json — it appears after the first
  // `npm install` — so every stage falls back to `npm install` when absent.
  const entrypoint = stack === 'nodejs' ? 'dist/index.js' : 'dist/main.js';

  return [
    `FROM node:${nodeVersion}-alpine AS deps`,
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi',
    '',
    `FROM node:${nodeVersion}-alpine AS builder`,
    'WORKDIR /app',
    'COPY --from=deps /app/node_modules ./node_modules',
    'COPY . .',
    'RUN npm run build',
    '',
    `FROM node:${nodeVersion}-alpine AS runner`,
    'WORKDIR /app',
    'ENV NODE_ENV=production',
    'ENV PORT=3000',
    'RUN addgroup -S nodejs && adduser -S app -G nodejs',
    'COPY --from=builder /app/package*.json ./',
    'RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; else npm install --omit=dev --ignore-scripts; fi',
    'COPY --from=builder --chown=app:nodejs /app/dist ./dist',
    'USER app',
    'EXPOSE 3000',
    `CMD ["node", "${entrypoint}"]`,
    ''
  ].join('\n');
}

function buildDockerignore(): string {
  return [
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.env',
    '.env.*',
    '!.env.example',
    '.git',
    '.github',
    ''
  ].join('\n');
}

// ─── Shape assembly ───────────────────────────────────────────────────────────

function buildStandaloneScaffold(options: BuildScaffoldOptions): ScaffoldFile[] {
  const stack = normalizeProjectStack(options.stack);
  const { serviceName, description, nodeVersion = '22' } = options;
  const includeDocker = options.includeDocker ?? false;
  const packageName = toPackageName(serviceName);

  const files: ScaffoldFile[] = [
    { path: 'README.md', content: buildReadme(serviceName, stack, description, includeDocker) },
    { path: '.gitignore', content: buildGitignore() },
    { path: 'package.json', content: buildPackageJson(packageName, stack) },
    { path: 'tsconfig.json', content: buildTsConfig(stack) },
    { path: 'jest.config.ts', content: buildJestConfig() },
    { path: 'eslint.config.mjs', content: buildEslintConfig() },
    { path: '.env.example', content: buildEnvExample(stack) },
    /**
     * `nodejs` gets its real entry point here -- listening on `PORT`, `/health`
     * and all -- rather than the generic SERVICE_NAME placeholder every other
     * stack still gets at this same path. Everything else about that
     * placeholder (why it exists, why react has none) is unchanged.
     */
    {
      path: 'src/index.ts',
      content: stack === 'nodejs' ? buildNodeIndex() : buildEntryPoint(serviceName)
    },
    { path: 'tests/README.md', content: buildTestsReadme() },
    {
      path: 'tests/unit/index.spec.ts',
      content: stack === 'nodejs' ? buildNodeHealthSpec(serviceName) : buildEntrySpec(serviceName, '../../src/index')
    }
  ];

  if (stack === 'nodejs') {
    files.push({ path: 'src/app.ts', content: buildNodeApp(serviceName) });
  }

  /**
   * Only the stacks that compile with tsc need an emit config.
   *
   * `next build` and `vite build` each run their own pipeline, and shipping a
   * `tsconfig.build.json` neither of them reads is a file that looks load-bearing
   * and is not.
   */
  if (stack !== 'nextjs' && stack !== 'react') {
    files.push({ path: 'tsconfig.build.json', content: buildBuildTsConfig() });
  }

  /**
   * A browser app has no service entry point.
   *
   * `src/index.ts` exports a SERVICE_NAME constant and `tests/unit/index.spec.ts`
   * asserts it — right for a Node service, and for React it was the whole
   * illusion: a file the toolchain treated as the program, next to an App.tsx
   * nothing rendered. `src/main.tsx` is the entry point here.
   */
  if (stack === 'react') {
    const nodeEntryPoints = new Set(['src/index.ts', 'tests/unit/index.spec.ts']);
    for (let i = files.length - 1; i >= 0; i -= 1) {
      if (nodeEntryPoints.has(files[i].path)) files.splice(i, 1);
    }
  }

  if (stack === 'nestjs') {
    files.push(
      { path: 'src/app.module.ts', content: buildNestAppModule() },
      { path: 'src/app.controller.ts', content: buildNestAppController() },
      { path: 'src/main.ts', content: buildNestMain() },
      { path: 'tests/unit/app.controller.spec.ts', content: buildNestAppControllerSpec() }
    );
  } else if (stack === 'nextjs') {
    files.push(
      { path: 'src/app/layout.tsx', content: buildNextLayout(serviceName) },
      { path: 'src/app/page.tsx', content: buildNextPage(serviceName) },
      { path: 'next.config.ts', content: buildNextConfig() }
    );
  } else if (stack === 'react') {
    files.push(
      { path: 'index.html', content: buildViteIndexHtml(serviceName) },
      { path: 'vite.config.ts', content: buildViteConfig() },
      { path: 'src/main.tsx', content: buildViteMain() },
      { path: 'src/App.tsx', content: buildReactApp(serviceName) },
      { path: 'tests/unit/App.spec.tsx', content: buildReactAppSpec(serviceName, '../../src/App') }
    );
  }

  if (includeDocker) {
    files.push(
      { path: 'Dockerfile', content: buildDockerfile(nodeVersion, stack) },
      { path: '.dockerignore', content: buildDockerignore() }
    );
  }

  return files;
}

/**
 * Build the file list for a new repository.
 *
 * Only the standalone shape is implemented. Monorepo, microservices and
 * multi-repo are recognised by normalizeRepoShape but not yet emitted — the
 * last two create *two* repositories, which is a different operation than this
 * one, so they are deliberately not silently downgraded here.
 */
export function buildProjectScaffold(options: BuildScaffoldOptions): ScaffoldFile[] {
  const shape = normalizeRepoShape(options.repoShape);

  if (shape !== 'standalone') {
    throw new Error(
      `Repository shape "${shape}" is not supported yet. Use "standalone".`
    );
  }

  return buildStandaloneScaffold(options);
}
