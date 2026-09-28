import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Room for the tests that boot the whole API.
     *
     * Several start Express, SQLite and the route stack per test, which takes
     * well under a second alone but can pass 5s when every core is running
     * one -- the default limit -- so a full run failed on a different handful
     * each time while each file passed on its own. A hung test still fails.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      /**
       * Keep role-resolution tests independent of a developer's local `.env`.
       * `databaseTokenExchange.test.ts` supplies mocked memberships for this
       * fixture organisation; production still requires its own ALPHA_ORG.
       */
      ALPHA_ORG: 'alpha-test-org',
      /**
       * Never the real cloud from a test.
       *
       * `env.ts` loads the developer's own `.env`, which on a team machine
       * names the Render service -- and a desktop with a cloud configured
       * relays its workspace routes there, as the developer's GitHub account.
       * Set empty here because dotenv does not overwrite a variable that is
       * already set. A test that wants a cloud sets its own, fake one.
       */
      ALPHA_CLOUD_API: ''
    }
  }
});
