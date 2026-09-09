import { describe, it, expect } from 'vitest';
import { buildProjectScaffold, SUPPORTED_STACKS, CanonicalStack } from './scaffoldBuilder.js';

/**
 * A scaffold has to be the kind of thing it claims to be.
 *
 * The React stack shipped for months as a Node program: `dev` ran
 * `ts-node src/index.ts`, `start` ran `node dist/index.js`, and `App.tsx` sat
 * beside them with no bundler, no `index.html`, and nothing mounting it. It
 * compiled, its tests passed, and every existing scaffold test agreed with it —
 * because they assert file *contents*, and the file contents were fine. What
 * was wrong was the shape of the whole thing.
 *
 * So these assert the properties that make a stack what it is, rather than what
 * any single file says. A `npm install && npm run build` per stack is the real
 * proof and lives outside the unit suite; this is the cheap guard that fails in
 * milliseconds when someone gives a web stack a Node entry point again.
 */

const paths = (stack: CanonicalStack) =>
  buildProjectScaffold({ serviceName: 'Demo App', stack }).map(f => f.path);

const pkg = (stack: CanonicalStack) => {
  const file = buildProjectScaffold({ serviceName: 'Demo App', stack })
    .find(f => f.path === 'package.json');
  return JSON.parse(file!.content) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
};

/** Stacks a browser is supposed to load. */
const WEB_STACKS: CanonicalStack[] = ['react', 'nextjs'];
/** Stacks that are services, and correctly have no HTML. */
const SERVICE_STACKS: CanonicalStack[] = ['nodejs', 'nestjs'];

describe('every scaffold', () => {
  it.each(SUPPORTED_STACKS)('%s produces the files a project needs', stack => {
    const files = paths(stack);
    for (const required of ['package.json', 'tsconfig.json', 'README.md', '.gitignore']) {
      expect(files).toContain(required);
    }
  });

  it.each(SUPPORTED_STACKS)('%s can be built and tested by name', stack => {
    const { scripts } = pkg(stack);
    for (const script of ['build', 'dev', 'test', 'typecheck', 'lint']) {
      expect(scripts[script], `${stack} has no ${script} script`).toBeTruthy();
    }
  });
});

describe('web stacks', () => {
  /**
   * The check that would have caught it.
   *
   * A browser needs a document. React had none, so there was nothing to open.
   */
  it.each(WEB_STACKS)('%s has something a browser can load', stack => {
    const files = paths(stack);
    const hasDocument =
      files.includes('index.html') || files.some(f => f.startsWith('src/app/'));
    expect(hasDocument, `${stack} emits no HTML document or app router entry`).toBe(true);
  });

  it.each(WEB_STACKS)('%s ships a bundler', stack => {
    const { dependencies, devDependencies } = pkg(stack);
    const all = { ...dependencies, ...devDependencies };
    const bundled = 'vite' in all || 'next' in all;
    expect(bundled, `${stack} has react but nothing to bundle it`).toBe(true);
  });

  it.each(WEB_STACKS)('%s does not develop or start through node', stack => {
    // `ts-node src/index.ts` and `node dist/index.js` are how a web stack ends
    // up being a command-line program nobody can open.
    const { scripts } = pkg(stack);
    expect(scripts.dev).not.toMatch(/\bts-node\b/);
    expect(scripts.start).not.toMatch(/^node\s/);
  });

  it('react mounts its component', () => {
    const files = buildProjectScaffold({ serviceName: 'Demo App', stack: 'react' });
    const main = files.find(f => f.path === 'src/main.tsx');
    expect(main, 'react has no entry point that mounts App').toBeTruthy();
    expect(main!.content).toContain('createRoot');
    expect(main!.content).toContain("from './App'");

    // And the document points at that entry point rather than nothing.
    const html = files.find(f => f.path === 'index.html')!.content;
    expect(html).toContain('/src/main.tsx');
    expect(html).toContain('id="root"');
  });

  it('react carries no service entry point', () => {
    // src/index.ts exporting SERVICE_NAME is what made the stack read as a
    // service to its own toolchain.
    const files = paths('react');
    expect(files).not.toContain('src/index.ts');
    expect(files).not.toContain('tests/unit/index.spec.ts');
  });
});

describe('service stacks', () => {
  it.each(SERVICE_STACKS)('%s stays a service', stack => {
    // The inverse guard: giving these a bundler would be just as wrong.
    const files = paths(stack);
    expect(files).toContain('src/index.ts');
    expect(files).not.toContain('index.html');
    expect(pkg(stack).devDependencies).not.toHaveProperty('vite');
  });
});
