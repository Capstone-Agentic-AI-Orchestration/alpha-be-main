import { describe, expect, it } from 'vitest';

import { resolveClientWebOrigin } from './clientWebOrigin.js';

const api = 'https://alpha-api.onrender.com/api';

describe('client web origin resolution', () => {
  it('uses the single exact HTTPS web origin from the existing CORS allowlist', () => {
    expect(resolveClientWebOrigin(
      'http://localhost:5173,https://alpha-fe-main-*-team.vercel.app,https://alpha-fe.vercel.app', api,
    )).toBe('https://alpha-fe.vercel.app');
  });

  it('fails closed when the allowlist has no single canonical HTTPS web origin', () => {
    expect(resolveClientWebOrigin('http://localhost:5173,https://alpha-fe-*-team.vercel.app', api)).toBeNull();
    expect(resolveClientWebOrigin('https://alpha-fe.vercel.app,https://alpha-preview.vercel.app', api)).toBeNull();
  });

  it('does not mistake the API origin for the website origin', () => {
    expect(resolveClientWebOrigin('https://alpha-api.onrender.com,https://alpha-fe.vercel.app', api))
      .toBe('https://alpha-fe.vercel.app');
    expect(resolveClientWebOrigin('https://alpha-api.onrender.com', api)).toBeNull();
  });

  it('rejects an invalid API base instead of guessing a client link destination', () => {
    expect(resolveClientWebOrigin('https://alpha-fe.vercel.app', 'https://alpha-api.onrender.com'))
      .toBeNull();
    expect(resolveClientWebOrigin('https://alpha-fe.vercel.app', 'http://alpha-api.onrender.com/api'))
      .toBeNull();
  });
});
