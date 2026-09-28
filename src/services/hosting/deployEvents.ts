/** Which lane a deployment went out on: `main`'s production, or a preview of another branch. */
export type ProviderDeployEnvironment = 'production' | 'preview';

/** One deployment, as Render or Vercel reports it, in one shape for both. */
export interface ProviderDeployEvent {
  id: string;
  status: string;
  createdAt: string;
  readyAt: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  /**
   * Who started the deployment, by the login the provider shows for them.
   * Null where the provider does not say.
   */
  createdBy: string | null;
  trigger: string | null;
  // The URL this one deployment answers on, for providers that give every
  // deployment its own hostname. Render reuses a single stable service URL
  // per service, so it returns null and callers fall back to the service URL.
  deploymentUrl: string | null;
  environment: ProviderDeployEnvironment | null;
  // Set only when the deployment was built for a pull request. A preview can
  // exist without one (a push to a non-production branch with no PR open).
  pullRequestNumber: number | null;
  // Git ref the deployment was built from.
  commitRef: string | null;
  // Provider console URL for this single deployment, as opposed to the
  // project-level console link.
  inspectorUrl: string | null;
}
