import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { createTestDatabase } from '../store/testDatabase.js';

/**
 * What the row-level security policies actually enforce.
 *
 * These are not defence in depth. The desktop app talks to Postgres directly —
 * it has to, because Render's free tier cold-starts at around thirty seconds
 * and a developer will not accept that on every board action — so a
 * developer's machine holds a token that reaches this database, and the checks
 * in the Express routes are not in that path. What stands between one
 * developer's session and another's conversations is the policies below.
 *
 * So they are tested behaviourally, against a real Postgres, as an
 * unprivileged role. Reading the SQL is not enough: the first version of the
 * artifact policy read correctly and granted nothing, because RLS composes
 * through subqueries and the policy asked a question the caller was forbidden
 * to ask. Only running it showed that.
 *
 * PGlite is Postgres compiled to WebAssembly — the real planner and the real
 * policy machinery, with no container to start.
 */

let db: PGlite;

/** Run as the unprivileged role, with these JWT claims. */
async function as<T>(
  login: string,
  role: 'client' | 'dev' | 'pm' | 'admin',
  fn: () => Promise<T>,
  workspace = 'ws1'
): Promise<T> {
  await db.exec(
    `update auth._claims set v = '${JSON.stringify({
      sub: login,
      workspace_id: workspace,
      alpha_role: role,
      // What supabaseTokenService stamps; 0004 ignores claims without it.
      iss: 'alpha'
    })}'::jsonb`
  );
  await db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}

const rows = async (sql: string) => (await db.query(sql)).rows.length;

beforeAll(async () => {
  // Supabase's `auth.jwt()` is stubbed there as a one-row table, which is how
  // `as()` swaps the caller's claims between statements.
  db = await createTestDatabase();

  // Seeded as superuser, for whom RLS does not apply.
  await db.exec(`
    insert into workspaces (id,name,slug) values ('ws1','Alpha','alpha');
    insert into projects (id,workspace_id,name,key) values ('p1','ws1','Checkout','EC');
    insert into issues (id,workspace_id,identifier,title,status,priority,project_id)
      values ('i1','ws1','EC-1','Fix cart','todo','high','p1');

    insert into chat_threads (id,workspace_id,owner_id,title) values
      ('t-lloyd','ws1','Lloyd1020','Lloyd thread'),
      ('t-zane','ws1','ZaneZamoraC1Cs','Zane thread');
    insert into chat_messages (id,thread_id,sender_type,sender_name,content) values
      ('m1','t-lloyd','user','Lloyd1020','my secret prompt'),
      ('m2','t-zane','user','ZaneZamoraC1Cs','zane secret prompt');

    insert into agent_calls (id,workspace_id,project_id,thread_id,squad_id,agent_id,
                             requested_by,operation_mode,status,instruction)
      values ('c1','ws1','p1','t-lloyd','s1','a1','Lloyd1020','implement','queued','do the thing');
    insert into agent_call_artifacts (id,agent_call_id,workspace_id,owner_id,artifact_type,content)
      values ('art1','c1','ws1','Lloyd1020','patch','diff --git a/x b/x');

    insert into prototype_runs (id,workspace_id,owner_id,issue_id,project_id,agent_id,status,stages)
      values ('r1','ws1','Lloyd1020','i1','p1','a1','running','[]'::jsonb);

    insert into remote_actions (id,workspace_id,actor,action,succeeded)
      values ('ra1','ws1','Lloyd1020','push',true);

    -- What Supabase grants authenticated out of the box: the auth schema,
    -- and table privileges on public through default privileges. Deliberately
    -- NOT usage on alpha. That grant belongs to the migration, and granting it
    -- here is how its absence went unnoticed.
    grant usage on schema public, auth to authenticated;
    grant select on auth._claims to authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant usage on schema realtime to authenticated;
    grant select, insert on realtime.messages to authenticated;
  `);
});

afterAll(async () => { await db?.close(); });

/**
 * The decision this whole per-developer split was made for: a developer's
 * prompts are their working notes, not managed output. A PM sees the work —
 * runs, stages, patches — and not the thinking that produced it.
 */
describe('conversations are private, with no overseer bypass', () => {
  it('shows a developer only their own threads', async () => {
    expect(await as('Lloyd1020', 'dev', () => rows('select * from chat_threads'))).toBe(1);
  });

  /** The gap this closes: GET /chat/threads filtered by workspace_id alone. */
  it('hides one developer\'s thread from another', async () => {
    expect(
      await as('ZaneZamoraC1Cs', 'dev', () => rows(`select * from chat_threads where id='t-lloyd'`))
    ).toBe(0);
  });

  it('hides one developer\'s messages from another', async () => {
    expect(
      await as('ZaneZamoraC1Cs', 'dev', () => rows(`select * from chat_messages where id='m1'`))
    ).toBe(0);
  });

  it('hides developer threads from a project manager', async () => {
    expect(await as('LloydLim1', 'pm', () => rows('select * from chat_threads'))).toBe(0);
  });

  /** `instruction` is the prompt, so the call is as private as the thread. */
  it('hides the prompt behind an agent call from a project manager', async () => {
    expect(await as('LloydLim1', 'pm', () => rows('select * from agent_calls'))).toBe(0);
  });
});

describe('work product is visible to oversight', () => {
  it('shows runs to a project manager', async () => {
    expect(await as('LloydLim1', 'pm', () => rows('select * from prototype_runs'))).toBe(1);
  });

  /**
   * The case that failed first time round.
   *
   * This policy deliberately grants *more* than the policy on the parent
   * `agent_calls` row. An `exists (select 1 from agent_calls ...)` check cannot
   * express that: RLS applies inside a policy's subqueries, so the lookup runs
   * under the caller's own access to agent_calls — none, for a PM — and the
   * grant silently never fires. Owner and workspace are denormalised onto the
   * artifact so the decision needs no parent read.
   */
  it('shows the patch to a project manager who cannot see the call', async () => {
    expect(await as('LloydLim1', 'pm', () => rows('select * from agent_call_artifacts'))).toBe(1);
  });

  it('hides the patch from an unrelated developer', async () => {
    expect(
      await as('ZaneZamoraC1Cs', 'dev', () => rows('select * from agent_call_artifacts'))
    ).toBe(0);
  });

  it('shows a developer their own run and not another\'s', async () => {
    expect(await as('Lloyd1020', 'dev', () => rows('select * from prototype_runs'))).toBe(1);
    expect(await as('ZaneZamoraC1Cs', 'dev', () => rows('select * from prototype_runs'))).toBe(0);
  });
});

describe('the board is shared, clients are scoped out of it', () => {
  /** Workspace-wide project read is the "All Projects" discovery tab. */
  it('shows every workspace project to any developer', async () => {
    expect(await as('ZaneZamoraC1Cs', 'dev', () => rows('select * from projects'))).toBe(1);
  });

  it('keeps a client out of the issue tracker', async () => {
    expect(await as('acme', 'client', () => rows('select * from issues'))).toBe(0);
  });

  it('lets a developer read issues', async () => {
    expect(await as('ZaneZamoraC1Cs', 'dev', () => rows('select * from issues'))).toBe(1);
  });
});

describe('a workspace is a hard boundary', () => {
  /** Even for admin: the strongest role must not cross workspaces. */
  it('shows nothing to an admin token scoped to another workspace', async () => {
    expect(
      await as('Lloyd1020', 'admin', () => rows('select * from projects'), 'ws-other')
    ).toBe(0);
    expect(
      await as('Lloyd1020', 'admin', () => rows('select * from chat_threads'), 'ws-other')
    ).toBe(0);
  });
});

/**
 * The two halves of the claims contract, checked against each other.
 *
 * Everything above feeds the policies hand-written claims, which proves the
 * policies work but not that anything produces claims in that shape. A name
 * that drifts between `supabaseTokenService` and the migration does not fail
 * loudly — the policy reads `null` and denies everything, or matches a row it
 * should not.
 *
 * So this decodes a genuinely minted token and feeds the policies exactly what
 * the server would send.
 */
describe('a real minted token satisfies the policies', () => {
  afterAll(() => {
    delete process.env.ALPHA_MODE;
  });

  async function claimsFromRealToken(
    login: string,
    role: 'client' | 'dev' | 'pm' | 'admin',
    workspace = 'ws1'
  ) {
    process.env.SUPABASE_JWT_SECRET = 'integration-test-secret';
    // Minting is cloud-only; this is the token the cloud would send.
    process.env.ALPHA_MODE = 'cloud';
    /*
     * Re-evaluated so the settings above are the ones it reads. `config/env`
     * reads the environment once, at import, and anything else in this file
     * that reaches it -- the test database does, for its error type -- would
     * otherwise have already fixed the mode as desktop.
     */
    vi.resetModules();
    const { mintSupabaseToken } = await import('./supabaseTokenService.js');
    const { token } = mintSupabaseToken({ sub: login, workspace_id: workspace, alpha_role: role });
    // Exactly what Supabase would hand the policies after verifying it.
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  }

  async function asToken<T>(
    login: string,
    role: 'client' | 'dev' | 'pm' | 'admin',
    fn: () => Promise<T>
  ): Promise<T> {
    const claims = await claimsFromRealToken(login, role);
    await db.exec(`update auth._claims set v = '${JSON.stringify(claims)}'::jsonb`);
    await db.exec('set role authenticated');
    try { return await fn(); } finally { await db.exec('reset role'); }
  }

  it('lets a developer read their own thread with a minted token', async () => {
    expect(await asToken('Lloyd1020', 'dev', () => rows('select * from chat_threads'))).toBe(1);
  });

  it('still hides it from another developer with a minted token', async () => {
    // Zane owns t-zane, so he correctly sees exactly one thread: his own.
    // Asserting zero here would be asserting that the policy is broken.
    expect(
      await asToken('ZaneZamoraC1Cs', 'dev', () => rows('select * from chat_threads'))
    ).toBe(1);
    expect(
      await asToken('ZaneZamoraC1Cs', 'dev', () =>
        rows(`select * from chat_threads where id='t-lloyd'`))
    ).toBe(0);
  });

  it('still hides prompts from a project manager with a minted token', async () => {
    expect(await asToken('LloydLim1', 'pm', () => rows('select * from agent_calls'))).toBe(0);
    expect(await asToken('LloydLim1', 'pm', () => rows('select * from prototype_runs'))).toBe(1);
  });
});

describe('only tokens Alpha issued are trusted', () => {
  /**
   * Supabase checks a token's signature, not its issuer, and Supabase Auth
   * signs with the same secret. A token it minted -- or anything else signed
   * with the project secret -- must read as nobody, however admin its claims.
   */
  async function asForeignIssuer<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec(
      `update auth._claims set v = '${JSON.stringify({
        sub: 'LloydLim1',
        workspace_id: 'ws1',
        alpha_role: 'admin',
        // Anything but Alpha's issuer; Supabase's own keys say 'supabase'.
        iss: 'supabase'
      })}'::jsonb`
    );
    await db.exec('set role authenticated');
    try {
      return await fn();
    } finally {
      await db.exec('reset role');
    }
  }

  it('grants an Alpha-issued admin token the workspace', async () => {
    expect(await as('LloydLim1', 'admin', () => rows('select * from projects'))).toBe(1);
  });

  it('grants the same claims nothing when another issuer signed them', async () => {
    expect(await asForeignIssuer(() => rows('select * from projects'))).toBe(0);
    expect(await asForeignIssuer(() => rows('select * from prototype_runs'))).toBe(0);
    expect(await asForeignIssuer(() => rows('select * from remote_actions'))).toBe(0);
  });

  it('does not let a foreign token read skills just by having a subject', async () => {
    await db.exec(
      `insert into skills (id, name, category, permissions, description)
       values ('s-probe', 'Probe', 'test', 'read', 'visible to Alpha tokens only')
       on conflict (id) do nothing`
    );
    expect(await as('Lloyd1020', 'dev', () => rows('select * from skills'))).toBe(1);
    expect(await asForeignIssuer(() => rows('select * from skills'))).toBe(0);
  });
});

describe('a run channel is exactly as private as the run', () => {
  /**
   * Realtime evaluates a private channel by querying realtime.messages with
   * the channel's name in realtime.topic(): SELECT to join and receive,
   * INSERT to send. `r1` belongs to Lloyd1020 in ws1 (seeded above).
   */
  async function onChannel<T>(topic: string, fn: () => Promise<T>): Promise<T> {
    await db.exec(`select set_config('realtime.topic', '${topic}', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`select set_config('realtime.topic', '', false)`);
    }
  }

  const received = () => rows(`select * from realtime.messages where event = 'probe'`);
  const send = () =>
    db.query(
      `insert into realtime.messages (topic, extension, event, payload)
       values (realtime.topic(), 'broadcast', 'sent', '{}'::jsonb)`
    );

  beforeAll(async () => {
    await db.exec(
      `insert into realtime.messages (topic, extension, event, payload)
       values ('run:r1', 'broadcast', 'probe', '{}'::jsonb)`
    );
  });

  it('lets the owner listen to their run', async () => {
    expect(await onChannel('run:r1', () => as('Lloyd1020', 'dev', received))).toBe(1);
  });

  it("lets a project manager in the workspace listen, as oversight", async () => {
    expect(await onChannel('run:r1', () => as('LloydLim1', 'pm', received))).toBe(1);
  });

  it("keeps another developer off someone else's run", async () => {
    expect(await onChannel('run:r1', () => as('ZaneZamoraC1Cs', 'dev', received))).toBe(0);
  });

  it('keeps everyone off a run that does not exist', async () => {
    expect(await onChannel('run:nope', () => as('Lloyd1020', 'dev', received))).toBe(0);
  });

  it('lets only the owner publish on the channel', async () => {
    await expect(onChannel('run:r1', () => as('Lloyd1020', 'dev', send))).resolves.toBeTruthy();
    await expect(onChannel('run:r1', () => as('ZaneZamoraC1Cs', 'dev', send))).rejects.toThrow(/row-level security/);
    // Oversight is read-only: a PM can watch a run but not speak on it.
    await expect(onChannel('run:r1', () => as('LloydLim1', 'pm', send))).rejects.toThrow(/row-level security/);
  });
});

describe('the audit log is append-only', () => {
  /**
   * There is no update or delete policy on `remote_actions`, and with RLS
   * enabled an operation without a policy is denied. The omission is the
   * feature: an actor who can rewrite their own audit trail is not audited.
   */
  it('refuses to let an actor delete their own audit rows', async () => {
    await as('Lloyd1020', 'dev', () => db.query(`delete from remote_actions where id='ra1'`));
    const left = await db.query('select * from remote_actions');
    expect(left.rows).toHaveLength(1);
  });
});

describe('an agent is readable by whoever it says may address it', () => {
  /**
   * A developer's agent carries a prompt they wrote, and desktops publish
   * their agents here. Every member could read every row until `0011`, while
   * the application had always hidden a private one from everyone but its
   * owner -- so publishing would have handed those prompts to the team.
   */
  const seed = async () => {
    await db.exec(`
      insert into agents (id,workspace_id,name,role,model_provider,model_name,autonomy_level,owner,allowed_users) values
        ('a-everyone','ws1','Open','Developer','anthropic','claude-sonnet-5','supervised','Lloyd1020','everyone'),
        ('a-team','ws1','Team','Developer','anthropic','claude-sonnet-5','supervised','Lloyd1020','team'),
        ('a-admins','ws1','Admins','Developer','anthropic','claude-sonnet-5','supervised','Lloyd1020','admins'),
        ('a-lloyd','ws1','Mine','Developer','anthropic','claude-sonnet-5','supervised','Lloyd1020','private'),
        ('a-zane','ws1','Theirs','Developer','anthropic','claude-sonnet-5','supervised','ZaneZamoraC1Cs','private')
      on conflict (id) do nothing;
    `);
  };
  const visible = async (login: string, role: 'client' | 'dev' | 'pm' | 'admin') =>
    as(login, role, async () => (await db.query<{ id: string }>('select id from agents order by id')).rows.map(r => r.id));

  it('keeps one developer’s private agent from another', async () => {
    await seed();

    expect(await visible('Lloyd1020', 'dev')).toEqual(['a-everyone', 'a-lloyd', 'a-team']);
    expect(await visible('ZaneZamoraC1Cs', 'dev')).toEqual(['a-everyone', 'a-team', 'a-zane']);
  });

  it('shows a client only what is for everyone', async () => {
    await seed();

    expect(await visible('Client1', 'client')).toEqual(['a-everyone']);
  });

  /** An admin sees the admins-only agents, and still not a private one. */
  it('shows an administrator the admin agents but not a private one', async () => {
    await seed();

    expect(await visible('Admin1', 'admin')).toEqual(['a-admins', 'a-everyone', 'a-team']);
  });

  it('refuses a write to someone else’s private agent', async () => {
    await seed();

    await as('Lloyd1020', 'dev', async () => {
      const { rows } = await db.query(`update agents set name = 'Taken' where id = 'a-zane' returning id`);
      expect(rows).toEqual([]);
    });
  });
});

describe("an agent's execution config is not shared", () => {
  /**
   * CLI flags and environment variables are input to a process on a
   * developer's machine, and a shared row is writable by every developer and
   * readable by every member -- clients included. `0003` keeps both out of the
   * cloud rather than trusting a policy to guard them.
   */
  it('has no column for CLI arguments or environment variables', async () => {
    const { rows: columns } = await db.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'agents'
          and column_name in ('custom_cli_args', 'env_vars')`
    );
    expect(columns).toEqual([]);
  });
});
