import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // Restricted Windows workers may deny Vite's realpath on package imports.
  // This test-only setting avoids canonicalizing paths; app builds use Vite's
  // separate production configuration.
  resolve: { preserveSymlinks: true },
  test: {
    setupFiles: ['./src/test/setup.ts'],
    // The agent evaluation fixture has its own node:test suite, run inside each task copy.
    exclude: [...configDefaults.exclude, 'scripts/agent-eval/fixture/**'],
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
      // Tests select cloud mode explicitly and provide an in-memory store.
      // Do not inherit a developer's cloud deployment or SQLite path.
      ALPHA_MODE: 'desktop',
      ALPHA_PACKAGED: '',
      SQLITE_DB_PATH: '',
      DATABASE_URL: '',
      DATABASE_CA_CERT: '',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_JWT_SECRET: '',
      GITHUB_TOKEN: '',
      GH_TOKEN: '',
      GITHUB_CLIENT_SECRET: '',
      GITHUB_APP_ID: '',
      GITHUB_APP_PRIVATE_KEY: '',
      ALPHA_ADMINS: '',
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
      ALPHA_CLOUD_API: '',
      /**
       * Never a real hosting platform from a test, for the same reason: a
       * developer's .env may hold Render and Vercel tokens, which would make
       * every "not configured" path configured. A test that wants a platform
       * sets its own, fake token.
       */
      RENDER_API_KEY: '',
      RENDER_OWNER_ID: '',
      RENDER_REGION: '',
      VERCEL_TOKEN: '',
      VERCEL_TEAM_ID: '',
      ALPHA_TICKETING_ACK_EMAIL_ENABLED: '',
      TICKET_ACK_EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: '',
      RESEND_SENDER_EMAIL: '',
      RESEND_SENDER_NAME: '',
      RESEND_TEST_RECIPIENT: '',
      BREVO_API_KEY: '',
      BREVO_SENDER_EMAIL: '',
      BREVO_SENDER_NAME: '',
      ALPHAORCH_WORKFLOW_REPO: '',
      ALPHAORCH_WORKFLOW_REF: ''
    }
  }
});
