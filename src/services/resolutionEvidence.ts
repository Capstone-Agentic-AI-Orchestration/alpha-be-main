import path from 'node:path';
import { sameRepository } from '../utils/repositoryName.js';
import type { TeamProductPicture } from './productPicture.js';

/**
 * No fact without verified evidence (BLOCKER_RESOLUTION_PLAN principle 2). Every claim in an
 * Orchestrator fix cites text, and Alpha checks that the text is really there before anything acts
 * on it: a repository file at the build's current checkpoint, or a decision recorded in the team
 * product picture. One unverifiable citation and the fix goes to the person instead.
 */

/** Shorter quotes ("}", "return") would match almost any file and prove nothing. */
export const MIN_QUOTE_CHARS = 12;
export const MAX_QUOTE_CHARS = 600;
export const MAX_CITATIONS = 8;
/** Read at most this much of a cited file; a quote past it cannot be verified. */
const MAX_CITED_FILE_BYTES = 512 * 1024;

export type Citation =
  | { source: 'repository'; repository: string; path: string; quote: string }
  | { source: 'product_picture'; quote: string };

export type VerifiedCitation =
  | { source: 'repository'; repository: string; path: string; quote: string; commit: string }
  | { source: 'product_picture'; quote: string };

export interface CitationRefusal { citation: Citation; reason: string }

export interface CitationCheck {
  verified: VerifiedCitation[];
  refused: CitationRefusal[];
}

/** How the verifier reads a repository at the build's current checkpoint. */
export interface CheckpointReader {
  /** The repository's checkpoint in this build, or undefined when it is not part of the build. */
  checkpoint(repository: string): Promise<{ repository: string; dir: string; commit: string } | undefined>;
  /** File content at a commit; undefined when it is too large to read, throws when it is absent. */
  read(dir: string, commit: string, filePath: string, maxBytes: number): Promise<string | undefined>;
}

/**
 * What a product citation may quote, read from the team product picture's fields (never its
 * rendered text): the project brief and each recorded decision, one entry each.
 */
export function productRecordsOf(picture: Pick<TeamProductPicture, 'brief' | 'decisions'>): string[] {
  return [picture.brief ?? '', ...picture.decisions].map(record => record.trim()).filter(Boolean);
}

/** Whitespace-insensitive, so a quote wrapped or re-indented by the model still matches. */
export function normalizeQuote(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

/** A repository-relative path with no way out of the repository. */
export function isSafeRelativePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return Boolean(normalized) && !path.isAbsolute(normalized) && !/^[a-z]:/i.test(normalized) &&
    normalized.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

function quoteProblem(quote: string): string | undefined {
  const normalized = normalizeQuote(quote);
  if (normalized.length < MIN_QUOTE_CHARS) return `the quote is shorter than ${MIN_QUOTE_CHARS} characters, so it proves nothing`;
  if (normalized.length > MAX_QUOTE_CHARS) return `the quote is longer than ${MAX_QUOTE_CHARS} characters`;
  return undefined;
}

async function verifyRepositoryCitation(
  citation: Extract<Citation, { source: 'repository' }>,
  reader: CheckpointReader
): Promise<VerifiedCitation | string> {
  if (!isSafeRelativePath(citation.path)) return 'the path is not a repository-relative file path';
  const checkpoint = await reader.checkpoint(citation.repository).catch(() => undefined);
  if (!checkpoint || !sameRepository(checkpoint.repository, citation.repository)) return `${citation.repository} is not a repository in this build`;
  let content: string | undefined;
  try {
    content = await reader.read(checkpoint.dir, checkpoint.commit, citation.path.replace(/\\/g, '/'), MAX_CITED_FILE_BYTES);
  } catch {
    return `${citation.path} does not exist in ${citation.repository} at the build's checkpoint`;
  }
  if (content === undefined) return `${citation.path} is too large to verify`;
  if (!normalizeQuote(content).includes(normalizeQuote(citation.quote))) {
    return `the quoted text is not in ${citation.path} at the build's checkpoint`;
  }
  return { ...citation, repository: checkpoint.repository, path: citation.path.replace(/\\/g, '/'), commit: checkpoint.commit };
}

/**
 * Checks every citation. `productRecords` are the project's own product records, one entry each:
 * its brief and the decisions recorded in plans. Never the rendered product picture, whose board
 * cards, chat requests and build goals anyone on the board can write, and never its open
 * questions: a question cannot be its own answer. A quote must sit inside one record.
 */
export async function verifyCitations(
  citations: readonly Citation[],
  input: { reader: CheckpointReader; productRecords?: readonly string[] }
): Promise<CitationCheck> {
  const records = (input.productRecords ?? []).map(normalizeQuote).filter(Boolean);
  const verified: VerifiedCitation[] = [];
  const refused: CitationRefusal[] = [];
  for (const citation of citations.slice(0, MAX_CITATIONS)) {
    const problem = quoteProblem(citation.quote);
    if (problem) { refused.push({ citation, reason: problem }); continue; }
    if (citation.source === 'product_picture') {
      const quote = normalizeQuote(citation.quote);
      if (records.some(record => record.includes(quote))) {
        verified.push({ source: 'product_picture', quote: citation.quote });
      } else {
        refused.push({ citation, reason: 'the quoted decision is not in the project\'s brief or recorded decisions' });
      }
      continue;
    }
    const result = await verifyRepositoryCitation(citation, input.reader);
    if (typeof result === 'string') refused.push({ citation, reason: result });
    else verified.push(result);
  }
  for (const citation of citations.slice(MAX_CITATIONS)) {
    refused.push({ citation, reason: `only ${MAX_CITATIONS} citations are checked; cite the evidence that matters` });
  }
  return { verified, refused };
}
