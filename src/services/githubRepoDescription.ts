/** GitHub's limit on a repository description. Longer ones are refused with a 422. */
export const GITHUB_DESCRIPTION_MAX = 350;

/**
 * A description GitHub will accept for a new repository: one line, no control
 * characters, at most 350 characters. GitHub refuses anything else with a bare
 * "422 Repository creation failed", which is how a project's multi-line ground
 * rules once stopped its repositories from being created at all.
 *
 * Every creation path goes through this, so no caller has to remember the rule.
 * Returns undefined when nothing printable is left, so the field is left out.
 */
export function githubRepoDescription(text: string | null | undefined): string | undefined {
  // Control characters (line breaks and tabs included) become spaces, then runs of spaces collapse.
  const line = (text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  if (line.length <= GITHUB_DESCRIPTION_MAX) return line;
  const cut = line.slice(0, GITHUB_DESCRIPTION_MAX - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > GITHUB_DESCRIPTION_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
