/**
 * Frontmatter for hand-editable agent and memory files.
 *
 * Deliberately not a YAML dependency. The keys these files carry are a small
 * fixed set of scalars and flat string lists (see agentFileService), and a full
 * YAML parser would accept far more than that — anchors, nested maps, multi-line
 * block scalars — every one of which would then have to be mapped onto an
 * `Agent` field that cannot represent it. A narrow parser that rejects what it
 * does not understand is easier to reason about than a permissive one whose
 * output has to be re-validated anyway.
 *
 * Supported value forms:
 *   key: plain text          → string
 *   key: "quoted text"       → string (\n \r \t \" \\ unescaped)
 *   key: 'quoted text'       → string ('' unescapes to ')
 *   key: 42       / 1.5      → number
 *   key: true     / false    → boolean
 *   key: [a, "b c", d]       → string[]
 *
 * Anything else is kept as a trimmed string, which is why callers still validate
 * against the real union types rather than trusting what comes back.
 */

/**
 * Remove HTML comments from a markdown body.
 *
 * Both file kinds this module serves — personas and memory tiers — carry their
 * editing guidance in `<!-- -->` blocks, which are for whoever opens the file
 * and are noise in a prompt. Stripping them is what lets the guidance be
 * generous without every agent paying for it on every request.
 */
export function stripHtmlComments(text: string): string {
  return (text ?? '').replaceAll(/<!--[\s\S]*?-->/g, '');
}

/**
 * True when a markdown body says something beyond its own scaffolding.
 *
 * Comments and heading lines do not count, so a persona file stripped back to
 * `# Ada Lovelace` and a memory file left at `# User preferences` are both
 * correctly read as empty — the first falls back to the database column, the
 * second contributes nothing to the prompt. Without this, generated scaffolding
 * would masquerade as content everywhere.
 */
export function hasProse(text: string): boolean {
  return stripHtmlComments(text)
    .split('\n')
    .some(line => line.trim() && !line.trimStart().startsWith('#'));
}

/**
 * A markdown body reduced to what should actually be sent to a model.
 *
 * Removing a comment block leaves behind the blank lines that surrounded it, and
 * those stack into visible gaps once several files are concatenated into one
 * prompt — so runs of blank lines collapse to one.
 */
export function toPromptText(text: string): string {
  return stripHtmlComments(text)
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

export type FrontmatterValue = string | number | boolean | string[];
export type FrontmatterData = Record<string, FrontmatterValue>;

export interface MarkdownDocument {
  data: FrontmatterData;
  /** Everything after the closing fence, leading blank lines removed. */
  body: string;
}

const FENCE = '---';

/**
 * A BOM survives most editors and would otherwise make the opening fence fail
 * to match, silently turning a valid file into one with no frontmatter at all.
 */
function stripBom(text: string): string {
  return text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Split an inline list on commas that are not inside quotes. */
function splitList(inner: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());

  return out.filter(item => item.length > 0);
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

function unquote(raw: string): string {
  const quote = raw[0];
  const inner = raw.slice(1, -1);

  // Single quotes are literal in YAML apart from the doubled-quote escape.
  if (quote === "'") return inner.replaceAll("''", "'");

  return inner.replaceAll(/\\(["\\nrt])/g, (_match, ch: string) => ESCAPES[ch] ?? ch);
}

function parseValue(raw: string): FrontmatterValue {
  if (!raw) return '';

  if (raw.startsWith('[') && raw.endsWith(']')) {
    return splitList(raw.slice(1, -1).trim());
  }

  const isQuoted =
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
  if (isQuoted) return unquote(raw);

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }

  // Trailing comment on an unquoted scalar. Requires the space so that a value
  // which legitimately contains '#' (a hex colour) is left intact.
  const comment = raw.indexOf(' #');
  return comment >= 0 ? raw.slice(0, comment).trim() : raw;
}

/**
 * Split a document into frontmatter and body.
 *
 * A file with no opening fence, or with an opening fence that is never closed,
 * is treated as pure body. That is the forgiving choice on purpose: a persona
 * whose frontmatter the user mistyped should still contribute its prose rather
 * than vanish from the prompt.
 */
export function parseFrontmatter(raw: string): MarkdownDocument {
  const text = stripBom(raw ?? '').replaceAll('\r\n', '\n');

  if (!text.startsWith(`${FENCE}\n`)) return { data: {}, body: text.trim() };

  const lines = text.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) {
      close = i;
      break;
    }
  }
  if (close === -1) return { data: {}, body: text.trim() };

  const data: FrontmatterData = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const sep = line.indexOf(':');
    if (sep <= 0) continue;

    const key = line.slice(0, sep).trim();
    if (key) data[key] = parseValue(line.slice(sep + 1).trim());
  }

  return { data, body: lines.slice(close + 1).join('\n').trim() };
}

/**
 * Quote a scalar when leaving it bare would change how it parses back.
 *
 * The `true` / `42` cases matter more than they look: an agent legitimately
 * named "42" must not round-trip into the number 42 and then fail a string
 * check somewhere downstream.
 */
function formatString(value: string): string {
  const needsQuote =
    value === '' ||
    value !== value.trim() ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s/.test(value) ||
    /\s#/.test(value) ||
    /[\n\r"\\]/.test(value) ||
    value === 'true' ||
    value === 'false' ||
    value === 'null' ||
    /^-?\d+(?:\.\d+)?$/.test(value);

  if (!needsQuote) return value;

  const escaped = value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('\r', String.raw`\r`);

  return `"${escaped}"`;
}

function formatValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => formatString(String(item))).join(', ')}]`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return formatString(value);
}

/**
 * Render frontmatter + body back to a file.
 *
 * Key order follows insertion order of `data`, so callers control the layout by
 * the order they build the object — worth keeping stable, because these files
 * are diffed by hand and by git.
 */
export function serializeFrontmatter(data: FrontmatterData, body: string): string {
  const lines = [FENCE];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}: ${formatValue(value)}`);
  }

  lines.push(FENCE);

  return `${lines.join('\n')}\n\n${(body ?? '').trim()}\n`;
}
