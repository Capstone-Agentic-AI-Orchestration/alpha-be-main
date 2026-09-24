import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
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
