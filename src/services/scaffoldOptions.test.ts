import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What the create form offers is what the configured workflow library has
 * callers for: a library without monorepo callers must not offer a monorepo
 * that would then fail to create.
 */

const LIBRARY = 'example-org/ci-library';

async function load() {
  vi.resetModules();
  process.env.ALPHAORCH_WORKFLOW_REPO = LIBRARY;
  process.env.ALPHAORCH_WORKFLOW_REF = 'v1';
  return import('./scaffoldOptions.js');
}

/** A library holding exactly `templates` under workflow-templates/product/. */
function library(templates: string[]) {
  const prefix = `https://raw.githubusercontent.com/${LIBRARY}/v1/workflow-templates/product/`;
  return (async (url: string | URL) =>
    new Response(null, { status: templates.includes(String(url).slice(prefix.length)) ? 200 : 404 })) as unknown as typeof fetch;
}

const SINGLE = ['be-nodejs.yml', 'be-nestjs.yml', 'fe-nextjs.yml', 'fe-react.yml'];

afterEach(() => {
  delete process.env.ALPHAORCH_WORKFLOW_REPO;
  delete process.env.ALPHAORCH_WORKFLOW_REF;
});

describe('scaffold options', () => {
  it('offers a React + Node.js API monorepo when the library has both callers', async () => {
    const { getScaffoldOptions } = await load();
    const options = await getScaffoldOptions(library([...SINGLE, 'monorepo/web-react.yml', 'monorepo/api-nodejs.yml']));

    expect(options.monorepo).toEqual({
      frontend: [{ id: 'react', label: 'React', role: 'frontend' }],
      backend: [{ id: 'nodejs', label: 'Node.js API', role: 'backend' }]
    });
    expect(options.paired.frontend.map(option => option.id)).toEqual(['react', 'nextjs']);
    expect(options.standalone).toHaveLength(4);
    expect(options.error).toBeUndefined();
  });

  it('offers no monorepo, and says why, when the library predates monorepo callers', async () => {
    const { getScaffoldOptions } = await load();
    const options = await getScaffoldOptions(library(SINGLE));

    expect(options.monorepo).toEqual({ frontend: [], backend: [] });
    expect(options.standalone).toHaveLength(4);
    expect(options.error).toMatch(/no monorepo CI templates/);
  });
});
