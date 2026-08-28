import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  serializeFrontmatter,
  stripHtmlComments,
  hasProse,
  toPromptText,
  FrontmatterData
} from './frontmatter.js';

const doc = (fm: string, body = 'Body text.') => `---\n${fm}\n---\n\n${body}`;

describe('parseFrontmatter', () => {
  it('splits frontmatter from body', () => {
    const { data, body } = parseFrontmatter(doc('name: Ada Lovelace'));
    expect(data.name).toBe('Ada Lovelace');
    expect(body).toBe('Body text.');
  });

  it('treats a document with no fence as pure body', () => {
    const { data, body } = parseFrontmatter('# Just a heading\n\nSome prose.');
    expect(data).toEqual({});
    expect(body).toBe('# Just a heading\n\nSome prose.');
  });

  it('treats an unterminated fence as pure body rather than losing the prose', () => {
    const raw = '---\nname: Ada\n\nstill going';
    const { data, body } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(body).toContain('still going');
  });

  it('survives a BOM before the opening fence', () => {
    const { data } = parseFrontmatter(`﻿${doc('name: Ada')}`);
    expect(data.name).toBe('Ada');
  });

  it('normalises CRLF line endings', () => {
    const { data, body } = parseFrontmatter('---\r\nname: Ada\r\n---\r\n\r\nBody text.');
    expect(data.name).toBe('Ada');
    expect(body).toBe('Body text.');
  });

  it('parses numbers and booleans', () => {
    const { data } = parseFrontmatter(doc('temperature: 0.4\narchived: false\ncount: -3'));
    expect(data.temperature).toBe(0.4);
    expect(data.archived).toBe(false);
    expect(data.count).toBe(-3);
  });

  it('parses inline lists', () => {
    const { data } = parseFrontmatter(doc('skills: [sk-fs, sk-git, sk-bash]'));
    expect(data.skills).toEqual(['sk-fs', 'sk-git', 'sk-bash']);
  });

  it('keeps commas inside quoted list items', () => {
    const { data } = parseFrontmatter(doc('tags: ["a, b", c]'));
    expect(data.tags).toEqual(['a, b', 'c']);
  });

  it('reads an empty list as an empty array', () => {
    const { data } = parseFrontmatter(doc('skills: []'));
    expect(data.skills).toEqual([]);
  });

  it('unescapes double-quoted strings', () => {
    const { data } = parseFrontmatter(doc('label: "line one\\nline two"'));
    expect(data.label).toBe('line one\nline two');
  });

  it('treats single quotes as literal apart from the doubled escape', () => {
    const { data } = parseFrontmatter(doc("label: 'Ada''s persona'"));
    expect(data.label).toBe("Ada's persona");
  });

  it('keeps a quoted number as a string', () => {
    const { data } = parseFrontmatter(doc('name: "42"'));
    expect(data.name).toBe('42');
  });

  it('strips a trailing comment from an unquoted value', () => {
    const { data } = parseFrontmatter(doc('model: claude-sonnet-5 # the fast one'));
    expect(data.model).toBe('claude-sonnet-5');
  });

  it('keeps a hash that is part of the value', () => {
    const { data } = parseFrontmatter(doc('color: #6366f1'));
    expect(data.color).toBe('#6366f1');
  });

  it('ignores comment lines and blank lines inside the fence', () => {
    const { data } = parseFrontmatter(doc('# a comment\n\nname: Ada\n\n# another'));
    expect(data).toEqual({ name: 'Ada' });
  });

  it('ignores lines with no colon', () => {
    const { data } = parseFrontmatter(doc('name: Ada\nthis is not a key'));
    expect(data).toEqual({ name: 'Ada' });
  });

  it('lets the last duplicate key win', () => {
    const { data } = parseFrontmatter(doc('model: old\nmodel: new'));
    expect(data.model).toBe('new');
  });

  it('stops the fence at the first closing marker, so a body rule stays in the body', () => {
    const { data, body } = parseFrontmatter('---\nname: Ada\n---\n\nAbove.\n\n---\n\nBelow.');
    expect(data).toEqual({ name: 'Ada' });
    expect(body).toContain('Above.');
    expect(body).toContain('Below.');
  });

  it('returns an empty document for empty input', () => {
    expect(parseFrontmatter('')).toEqual({ data: {}, body: '' });
  });
});

describe('serializeFrontmatter', () => {
  it('round-trips scalars, lists and body', () => {
    const data: FrontmatterData = {
      name: 'Ada Lovelace',
      role: 'Architect',
      temperature: 0.4,
      skills: ['sk-fs', 'sk-git']
    };

    const reparsed = parseFrontmatter(serializeFrontmatter(data, 'The persona.'));
    expect(reparsed.data).toEqual(data);
    expect(reparsed.body).toBe('The persona.');
  });

  it('quotes a string that would otherwise parse back as a number', () => {
    const out = serializeFrontmatter({ name: '42' }, '');
    expect(out).toContain('name: "42"');
    expect(parseFrontmatter(out).data.name).toBe('42');
  });

  it('quotes a string that would otherwise parse back as a boolean', () => {
    expect(parseFrontmatter(serializeFrontmatter({ v: 'true' }, '')).data.v).toBe('true');
  });

  it('quotes a value containing a colon and space', () => {
    const value = 'Reviewer: security focus';
    expect(parseFrontmatter(serializeFrontmatter({ role: value }, '')).data.role).toBe(value);
  });

  it('escapes embedded newlines and quotes', () => {
    const value = 'says "hi"\nand more';
    expect(parseFrontmatter(serializeFrontmatter({ v: value }, '')).data.v).toBe(value);
  });

  it('preserves a leading-hash colour unquoted-safe', () => {
    expect(parseFrontmatter(serializeFrontmatter({ color: '#6366f1' }, '')).data.color).toBe(
      '#6366f1'
    );
  });

  it('keeps key order stable for hand-diffing', () => {
    const out = serializeFrontmatter({ name: 'A', role: 'B', model: 'C' }, '');
    expect(out.indexOf('name:')).toBeLessThan(out.indexOf('role:'));
    expect(out.indexOf('role:')).toBeLessThan(out.indexOf('model:'));
  });

  it('skips undefined and null values', () => {
    const out = serializeFrontmatter(
      { name: 'Ada', missing: undefined as any, nulled: null as any },
      ''
    );
    expect(out).toContain('name: Ada');
    expect(out).not.toContain('missing');
    expect(out).not.toContain('nulled');
  });

  it('ends with exactly one trailing newline', () => {
    expect(serializeFrontmatter({ name: 'Ada' }, 'Body.')).toMatch(/Body\.\n$/);
  });
});

describe('stripHtmlComments', () => {
  it('removes a single-line comment', () => {
    expect(stripHtmlComments('before <!-- note --> after')).toBe('before  after');
  });

  it('removes a multi-line comment', () => {
    expect(stripHtmlComments('a\n<!--\n  note\n  more\n-->\nb').trim()).toBe('a\n\nb');
  });

  it('removes several comments', () => {
    expect(stripHtmlComments('<!--a-->keep<!--b-->')).toBe('keep');
  });

  it('leaves text with no comments alone', () => {
    expect(stripHtmlComments('plain text')).toBe('plain text');
  });

  it('tolerates empty input', () => {
    expect(stripHtmlComments('')).toBe('');
  });
});

describe('hasProse', () => {
  it('is false for a comment-only body', () => {
    expect(hasProse('<!--\n  guidance\n-->')).toBe(false);
  });

  it('is false for headings alone', () => {
    expect(hasProse('# Title\n\n## Section')).toBe(false);
  });

  it('is false for whitespace', () => {
    expect(hasProse('  \n\t\n')).toBe(false);
  });

  it('is false for a heading plus a comment — the generated-file case', () => {
    expect(hasProse('# Ada Lovelace\n\n<!-- how to edit this file -->\n')).toBe(false);
  });

  it('is true as soon as one real line appears', () => {
    expect(hasProse('# Title\n\n<!-- note -->\n\nYou are Ada.')).toBe(true);
  });

  it('does not count a hash inside a comment as prose', () => {
    expect(hasProse('<!-- # not a heading, not prose -->')).toBe(false);
  });
});

describe('toPromptText', () => {
  it('collapses the gap a removed comment block leaves behind', () => {
    const body = '# Ada\n\n<!--\n  guidance\n-->\n\nYou are Ada.';
    expect(toPromptText(body)).toBe('# Ada\n\nYou are Ada.');
  });

  it('collapses any run of blank lines to one', () => {
    expect(toPromptText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('keeps a single blank line as a paragraph break', () => {
    expect(toPromptText('a\n\nb')).toBe('a\n\nb');
  });

  it('trims leading and trailing whitespace', () => {
    expect(toPromptText('\n\n  You are Ada.  \n\n')).toBe('You are Ada.');
  });

  it('is empty for a comment-only body', () => {
    expect(toPromptText('<!--\n  guidance\n-->')).toBe('');
  });
});
