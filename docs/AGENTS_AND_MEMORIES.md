# Alpha v2 — Agents and Memories Architecture Plan

**Status:** Current as of 2026-08-22. Single source of truth for Agent configuration, Squad orchestration, and the Multi-Tier Memory System.

---

## 1. Agent Architecture & Role Specialization

Alpha organizes agents into specialized roles, matching each role with the optimal underlying AI engine (Claude Code, Google Gemini, OpenAI Codex):

Roles map to a **capability tier**, never to a hardcoded model ID. Concrete IDs are resolved at runtime
from the model catalogue each CLI reports (`claude --help` / `gemini models list` / equivalent) and are
surfaced in the agent editor as a dropdown. See [§1.1](#11-why-no-hardcoded-model-ids).

| Agent Role | Primary Engine | Capability tier | Core responsibilities |
|---|---|---|---|
| **Architect** | Claude Code | Frontier reasoning | System blueprints, state design, multi-file planning |
| **Coder** | Claude Code | Frontier coding | Multi-file code generation, refactoring, implementation |
| **Reviewer** | Claude Code / Codex | Frontier reasoning | Security audit, diff review, injection hazard scanning |
| **QA Tester** | Claude Code | Mid coding | Unit test suites, Playwright E2E, edge-case bugs |
| **DevOps** | Gemini / Claude Code | Mid | Docker, CI/CD Actions, telemetry alerting |
| **Triager** | Gemini / Ollama | Fast / local | High-speed issue parsing, severity scoring, routing |
| **Researcher** | Gemini | Long-context | Documentation indexing, web & archive research |

### 1.1 Why no hardcoded model IDs

Every model string written into a document or a database schema is stale within months. An earlier draft
of these plans specified `claude-3-7-sonnet`, `o3-mini` and `gpt-4o` — none of which are current IDs.
The same stale string is still hardcoded at
[CreateAgentModal.tsx:29](file:///C:/Users/Lloyd/Documents/Projects/Capstone/Alpha-v2/alpha-fe-main/src/components/agents/CreateAgentModal.tsx).

**Rule:** the runtime catalogue is the only source of model IDs. Documents name tiers; the database stores
whatever the user picked; the picker is populated from the catalogue at detection time.

Current Anthropic IDs at time of writing, for orientation only — do not copy these into code:

| Model | Context | Input / Output per Mtok |
|---|---|---|
| `claude-opus-5` | 1M | $5 / $25 |
| `claude-sonnet-5` | 1M | $3 / $15 |
| `claude-haiku-4-5` | 200K | $1 / $5 |

Gemini and OpenAI IDs must be verified against those providers' current lists before use; do not assume
any ID that appears in this repository is still valid.

### Agent Configuration Schema (`Agent` Interface)

Stored in SQLite (`agents` table) and projected to a hand-editable markdown file
at `~/.alpha/agents/{agent-id}.md`.

**Implemented** — `alpha-be-main/src/services/agentFileService.ts`. Earlier drafts
of this document specified `{agent-name}.json`; the file is markdown keyed by
**agent id**, because the persona is prose (a JSON string field is no better than
the database column it replaced) and because a name can be edited while an id
cannot.

Precedence: the file wins for every field its frontmatter declares, and its body
is the system prompt. The database supplies whatever the file omits. Projection
back to disk preserves a hand-written body unless the system prompt itself
changed, so renaming an agent in the UI cannot discard a persona.

```markdown
---
name: Ada Lovelace
role: Architect
provider: Anthropic
model: claude-opus-5
autonomy: Semi-Autonomous (Requires Approval)
skills: [sk-fs, sk-git]
mcpServers: [alpha-github]
---

You are Ada. Lead with the interface, then the implementation.
```

The composed prompt reaches the CLI through `--append-system-prompt`, never
`--system-prompt` — the latter replaces the CLI's own default system prompt
outright, which left agents with a single sentence as their entire instruction.

The full structured record remains:

```ts
export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  avatar: string;
  color: string;
  description: string;
  owner: string;
  isMine: boolean;
  modelProvider: 'Anthropic' | 'Google Gemini' | 'OpenAI';
  modelName: string;
  systemPrompt: string;
  autonomyLevel: 'Supervised' | 'Semi-Autonomous (Requires Approval)' | 'Full Autonomy';
  temperature: number;
  skills: string[];        // Array of Skill IDs (e.g. ['sk-fs', 'sk-git', 'sk-bash'])
  mcpServers: string[];    // Array of MCP Server names (e.g. ['filesystem', 'postgres'])
  customCliArgs?: string;  // Custom CLI parameters passed to the runner
  envVars?: { key: string; value: string; isSecret?: boolean }[];
  concurrencyLimit: number;
}
```

---

## 2. Squads & Coordination Topologies

A **Squad** groups multiple agents to solve complex tasks that exceed a single agent's scope.

```
                      ┌───────────────────────────────────────────────┐
                      │                 Squad Engine                  │
                      └───────┬──────────────┬──────────────┬─────────┘
                              │              │              │
                    ┌─────────┘              │              └──────────┐
                    ▼                        ▼                         ▼
         1. Sequential Pipeline      2. Hierarchical Lead        3. Swarm / Consensus
      Researcher → Coder → Reviewer  Lead Agent delegates sub-  Multi-agent debate &
      (Step-by-step handoff)         tasks to worker agents     verification before merge
```

### Supported Topologies:
1. **Sequential:** Step-by-step waterfall. e.g. `Triager (Gemini)` creates subtasks &rarr; `Coder (Claude Code)` writes code &rarr; `Reviewer (Codex)` inspects PR.
2. **Hierarchical (Supervisor):** A Lead Agent (`Architect`) decomposes the issue into smaller subtasks, assigns them to individual agents, and aggregates results.
3. **Consensus:** Two or more Reviewer agents must both approve a patch before an issue can be submitted for human review.

---

## 3. The Multi-Tier Memory System

To make agents genuinely intelligent over time without ballooning prompt tokens, Alpha implements a **layered local memory architecture**:

```
~/.alpha/                         # root; override with the ALPHA_HOME env var
│
├── agents/                       # Persona files — one per agent, keyed by id
│   └── {AGENT_ID}.md             # frontmatter overrides alpha.db; body is the prompt
│
└── memory/
    ├── global/                   # Tier 1: cross-project brain, applies to every agent
    │   ├── preferences.md        # e.g. "Use TypeScript strict mode", "no emoji"
    │   ├── patterns.md           # reusable approaches proven across projects
    │   └── mistakes.md           # anti-patterns and errors not to repeat
    │
    ├── projects/                 # Tier 2: per-project partitions
    │   └── {PROJECT_KEY}/        # e.g. ALF/
    │       ├── architecture.md   # system overview, directory layout, dependencies
    │       ├── rules.md          # ground rules, conventions, test commands
    │       └── decisions.md      # ADRs recorded during runs
    │
    └── agents/                   # Tier 3: per-agent memory
        └── {AGENT_ID}/           # e.g. agent-kaelen/
            └── learnings.md      # persona takeaways and tool usage notes
```

### Memory Layers & Read/Write Lifecycle

| Memory Layer | Storage Format | When it is Read | When it is Updated |
|---|---|---|---|
| **Tier 1: Global Memory** | Markdown (`global/*.md`) | Primed into system prompts on every agent run. | Updated when the user specifies a global preference or fixes a common bug pattern. |
| **Tier 2: Project Memory** | Markdown (`projects/{KEY}/*.md`) | Read whenever an agent executes on an issue belonging to that project. | Updated after successful issue completions and pull request merges. |
| **Tier 3: Agent Memory** | Markdown (`agents/{AGENT_ID}/learnings.md`) | Primed into that agent's system prompt on every run. | Written by hand today; agent-authored updates are not implemented. |
| **Tier 4: Session Memory** | SQLite (`run_events`, `chat_messages`) | Real-time query during active conversation or multi-turn execution. | Append-only on every tool call and stream event. |

**Implemented** — `alpha-be-main/src/services/memoryService.ts`, composed into a
prompt by `personaService.ts`. Notes on the behaviour as built:

- **Scaffolding is free.** Every seeded file arrives with its guidance inside an
  HTML comment. A file holding nothing but comments and headings contributes zero
  characters to a prompt, so a fresh install pays nothing for the layer existing.
- **Order is global → project → agent, after the persona.** The last thing in a
  prompt carries the most weight, so a deliberately-edited preferences file
  overrides persona flavour rather than the reverse.
- **There is a budget.** `MEMORY_LIMITS` in `config/constants.ts` caps each file
  and the total; an over-long file is trimmed head-and-tail with the cut marked,
  and files dropped at the total cap are logged rather than silently omitted.
- **Tier 2 applies only to project work.** A chat thread belongs to no project,
  so chat runs compose Tier 1 and Tier 3 only.
- Writes are manual. Nothing yet writes memory back automatically — the
  "updated when" column above describes intent, not current behaviour.

---

## 4. Local Database Schema (`alpha.db`)

Solo mode uses a high-performance local SQLite database:

```sql
-- Agents Table
create table agents (
  id                    text primary key,
  name                  text not null,
  role                  text not null,
  avatar                text,
  color                 text,
  description           text,
  owner                 text default 'You',
  is_mine               integer default 1,
  model_provider        text not null,
  model_name            text not null,
  system_prompt         text not null default '',
  autonomy_level        text not null,
  skills                text not null default '[]',
  mcp_servers           text not null default '[]',
  custom_cli_args       text default '',
  env_vars              text not null default '[]',
  concurrency_limit     integer default 2,
  is_archived           integer default 0,
  created_at            text not null
);

-- Squads Table
create table squads (
  id                    text primary key,
  name                  text not null,
  topology              text not null,
  leader_agent_id       text references agents(id),
  member_agent_ids      text not null default '[]',
  mission               text not null,
  active_runs_count     integer default 0,
  completed_runs_count  integer default 0
);

-- Chat Threads & Messages Table (Multi-Turn Conversational Memory)
create table chat_threads (
  id                    text primary key,
  title                 text not null,
  last_message_snippet  text,
  last_message_at       text not null,
  agent_ids             text not null default '[]',
  created_at            text not null
);

create table chat_messages (
  id                    text primary key,
  thread_id             text not null references chat_threads(id) on delete cascade,
  sender_type           text not null, -- 'user' | 'agent' | 'system'
  sender_name           text not null,
  agent_id              text references agents(id),
  content               text not null,
  thinking_process      text,
  tools_executed        text default '[]',
  timestamp             text not null
);
```

---

## 5. Frontend Integration (`alpha-fe-main`)

1. **Roster Management ([AgentsView.tsx](file:///C:/Users/Lloyd/Documents/Projects/Capstone/Alpha-v2/alpha-fe-main/src/views/AgentsView.tsx)):**
   * Displays all active and archived agents with color badges, roles, and status dots.
   * Full profile inspector with sub-tabs for System Instructions, Enabled Skills, MCP Servers, Environment Variables, and Execution History.
2. **Agent Creation ([CreateAgentModal.tsx](file:///C:/Users/Lloyd/Documents/Projects/Capstone/Alpha-v2/alpha-fe-main/src/components/agents/CreateAgentModal.tsx)):**
   * Allows adding custom agents with custom avatars, system instructions, and provider selections.
3. **Conversational Multi-Turn ([ChatView.tsx](file:///C:/Users/Lloyd/Documents/Projects/Capstone/Alpha-v2/alpha-fe-main/src/views/ChatView.tsx)):**
   * Real-time streaming with collapsible thinking panels and tool execution chips.
4. **Squad Canvas ([SquadsView.tsx](file:///C:/Users/Lloyd/Documents/Projects/Capstone/Alpha-v2/alpha-fe-main/src/views/SquadsView.tsx)):**
   * Visualizes squad topologies and tracks active squad missions.
