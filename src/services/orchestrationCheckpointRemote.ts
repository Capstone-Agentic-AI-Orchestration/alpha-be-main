import { fetchCheckpointRef, pushCheckpointRef } from './githubService.js';
import type { CheckpointRemote } from './orchestrationCheckpoints.js';

/**
 * Where build checkpoints are backed up: the project's own GitHub repository.
 * Its own module so the test setup (src/test/setup.ts) can replace it: a test run
 * must never push to GitHub.
 */
export const githubCheckpointRemote: CheckpointRemote = { push: pushCheckpointRef, fetch: fetchCheckpointRef };
