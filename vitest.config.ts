import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
