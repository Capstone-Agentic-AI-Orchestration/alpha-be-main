import { describe, expect, it } from 'vitest';

import { clientAccessConfigurationProblems, resolveClientWebOrigin } from './clientWebOrigin.js';

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

  it('uses the browser origin when a separate API origin is also allowed', () => {
    expect(resolveClientWebOrigin('https://alpha-api.onrender.com,https://alpha-fe.vercel.app', api))
      .toBe('https://alpha-fe.vercel.app');
  });

  it('supports the existing same-origin website and API proxy', () => {
    expect(resolveClientWebOrigin('https://alpha-fe-main.vercel.app', 'https://alpha-fe-main.vercel.app/api'))
      .toBe('https://alpha-fe-main.vercel.app');
  });

  it('does not require the desktop cloud relay setting on the hosted backend', () => {
    expect(resolveClientWebOrigin('https://alpha-fe-main.vercel.app'))
      .toBe('https://alpha-fe-main.vercel.app');
    expect(resolveClientWebOrigin('file://,http://localhost:3000,https://alpha-fe-main.vercel.app', ''))
      .toBe('https://alpha-fe-main.vercel.app');
    expect(resolveClientWebOrigin('https://alpha-fe.vercel.app,https://alpha-preview.vercel.app', ''))
      .toBeNull();
  });

  it('rejects wildcard, credentialed, path, query and non-HTTPS browser destinations', () => {
    for (const origin of [
      'https://*.vercel.app', 'https://user:password@alpha-fe.vercel.app',
      'https://alpha-fe.vercel.app/path', 'https://alpha-fe.vercel.app?redirect=other',
      'https://alpha-fe.vercel.app#other', 'http://alpha-fe.vercel.app',
    ]) expect(resolveClientWebOrigin(origin, '')).toBeNull();
  });

  it('rejects an invalid API base instead of guessing a client link destination', () => {
    expect(resolveClientWebOrigin('https://alpha-fe.vercel.app', 'https://alpha-api.onrender.com'))
      .toBeNull();
    expect(resolveClientWebOrigin('https://alpha-fe.vercel.app', 'http://alpha-api.onrender.com/api'))
      .toBeNull();
  });
});

describe('client access startup diagnostics', () => {
  const configured = {
    webOrigin: 'https://alpha-fe-main.vercel.app', originAllowed: true,
    supabaseUrl: 'https://project.supabase.co', supabaseAnonKey: 'synthetic-anon',
    supabaseServiceRoleKey: 'synthetic-service-secret', sessionSecret: 'synthetic-session-secret-with-at-least-32-characters',
  };

  it('accepts the existing hosted configuration without new settings', () => {
    expect(clientAccessConfigurationProblems(configured)).toEqual([]);
  });

  it('reports setting names, never credentials, for missing or invalid setup', () => {
    const problems = clientAccessConfigurationProblems({ ...configured, webOrigin: null, originAllowed: false,
      supabaseUrl: 'https://secret:password@project.supabase.co', supabaseAnonKey: ' ',
      supabaseServiceRoleKey: '', sessionSecret: 'short-secret' });
    expect(problems).toHaveLength(5);
    expect(problems.join(',')).toContain('CORS_ORIGIN');
    expect(problems.join(',')).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(problems.join(',')).toContain('ALPHA_SESSION_SECRET');
    for (const secret of ['password', 'short-secret', 'secret:']) expect(problems.join(',')).not.toContain(secret);
  });

  it.each(['http://project.supabase.co', 'not-a-url', 'https://project.supabase.co/path', 'https://project.supabase.co?key=secret'])
    ('diagnoses invalid Supabase URL %s before constructing client auth', supabaseUrl => {
      expect(clientAccessConfigurationProblems({ ...configured, supabaseUrl })).toEqual(['valid HTTPS SUPABASE_URL']);
    });

  it('does not recommend rotating the existing shared secret', () => {
    expect(clientAccessConfigurationProblems({ ...configured, sessionSecret: '' }).join(',')).toContain('do not rotate');
  });
});
