/**
 * A pulled issue is `gh-issue-<issue id>`, GitHub's own number: stable across
 * renames and transfers of ownership, and the same on every machine that reads
 * it. Two copies of the board -- Postgres in the cloud, SQLite on a desktop --
 * then agree on what each card is without ever exchanging ids.
 *
 * This module also used to turn every repository in the organisation into a
 * project. A workspace's projects are the ones its PMs start, so that importer
 * is gone: it had filled the default workspace with every organisation
 * repository, visible to every member.
 */
export const issueIdFor = (githubIssueId: number): string => `gh-issue-${githubIssueId}`;
