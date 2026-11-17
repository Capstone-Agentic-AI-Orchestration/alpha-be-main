import { fetchCheckpointRef, githubService, pushCheckpointRef } from './githubService.js';
import { checkpointBackupRefusal, type CheckpointRemote } from './orchestrationCheckpoints.js';

/**
 * Where build checkpoints are backed up: the project's own GitHub repository, when it is
 * private (see checkpointBackupRefusal). Its own module so the test setup
 * (src/test/setup.ts) can replace it: a test run must never push to GitHub.
 */
export const githubCheckpointRemote: CheckpointRemote = {
  async push(checkoutDir, repository, commit, ref) {
    const checkout = await githubService.inspectLocalRepo(checkoutDir);
    const remote = await githubService.getRepository(repository);
    const refusal = checkpointBackupRefusal({ repository, checkoutRepository: checkout.ownerRepo, isPrivate: remote.isPrivate });
    if (refusal) throw new Error(`Checkpoint not backed up: ${refusal}`);
    await pushCheckpointRef(checkoutDir, repository, commit, ref);
  },
  fetch: fetchCheckpointRef
};
