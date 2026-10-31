# Architecture and Implementation Decisions (ADR)
**Project:** Alpha — Autonomous AI Orchestration Platform  
**Target Environments:** Vercel (Web Frontend) • Render (Cloud Backend) • Supabase (Cloud DB & Realtime) • Electron (Developer Desktop) • GitHub (Code & Collaboration)  
**Date:** September 20, 2026  
**Status:** Approved & Documented  
**Document Location:** `alpha-be-main/ARCHITECTURE_AND_IMPLEMENTATION_DECISIONS.md`

> Current status: the standalone Live Build Room has been removed. Project build snapshots remain available through project chat review; the section below records the original design.

---

## Table of Contents
1. [Executive Summary & System Topology](#1-executive-summary--system-topology)
2. [Project Architecture: Web vs. Desktop Synchronization](#2-project-architecture-web-vs-desktop-synchronization)
3. [Persona Model & Role-Based Access Control (RBAC)](#3-persona-model--role-based-access-control-rbac)
4. [The Dual-Database Strategy](#4-the-dual-database-strategy)
5. [Guarded Agent Call Lifecycle & Patch Management](#5-guarded-agent-call-lifecycle--patch-management)
6. [The Live Build Room Real-Time Collaboration Bridge](#6-the-live-build-room-real-time-collaboration-bridge)
7. [Desktop App Packaging, Distribution & Auto-Updates](#7-desktop-app-packaging-distribution--auto-updates)
8. [Authentication, GitHub Identity & Team Scoping](#8-authentication-github-identity--team-scoping)
9. [Phase-by-Phase Implementation Roadmap](#9-phase-by-phase-implementation-roadmap)
10. [Summary Decision Matrix](#10-summary-decision-matrix)

---

## 1. Executive Summary & System Topology

### 1.1 The Core Challenge
Autonomous AI coding agents require direct access to local filesystems, compilers, local git repositories, and local model runtimes (Ollama, LM Studio, Antigravity `agy`, Claude Code, Codex). Conversely, Project Managers (PMs) and Clients require a zero-install, always-accessible SaaS web dashboard to inspect progress, track milestones, approve specifications, and review deliverables without running terminal daemons, Node.js, or local checkouts.

### 1.2 System Topology: Hub-and-Spoke Architecture
To satisfy both requirements without compromise, the platform adopts a **Hub-and-Spoke (Cloud Control Plane / Local Execution Node)** architecture:

* **Cloud Control Plane (Vercel + Render + Supabase):** Serves as the central collaboration truth. Manages projects, specifications, Kanban issues, team RBAC, GitHub webhooks, and sub-200ms real-time event broadcasting.
* **Local Execution Node (Electron Desktop App):** Installed on developer workstations. Contains a local execution engine with access to local checkouts, terminal CLIs, test suites, and local LLMs, streaming telemetry back to the cloud.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                       CLOUD COLLABORATION CONTROL PLANE                          │
│                                                                                  │
│   [ Vercel: Web Frontend ] ─────────────────► [ Render: Cloud API Gateway ]      │
│   • PM, Client & Dev Web Portal                • Multi-Tenant Webhook Receiver   │
│   • Specs, Roadmaps, Kanban Board              • GitHub App Integration          │
│   • Live Build Room Observer                   • Workspace Authorization         │
│                 │                                             │                  │
│                 ▼                                             ▼                  │
│   [ Supabase Cloud: PostgreSQL & Realtime Event Bus ] ◄───────┘                  │
│   • Shared Projects, Issues, Comments, Agent Calls, Team Roster                  │
│   • Realtime WebSocket Channels: `workspace:${id}`, `run:${id}`                  │
└───────────────────────────────────────▲──────────────────────────────────────────┘
                                        │ (Realtime WebSocket Uplink)
┌───────────────────────────────────────┴──────────────────────────────────────────┐
│                         DEVELOPER WORKSTATION                                    │
│                                                                                  │
│   [ Electron Desktop App (alpha-desktop) ]                                       │
│   • Developer Persona Canvas & Integrated Suite                                  │
│   • Local Workspace Working Copies (Git branches, commits, diffs, test runners)  │
│   • Local AI Runtimes (Antigravity agy, Claude Code, Codex, Ollama :11434)       │
│   • Local Execution Engine (agentCallService.ts, cliRunner.ts, processManager)   │
│   • Local Store: SQLite (~/.alpha/alpha.db) for directory bindings & allowlists  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Project Architecture: Web vs. Desktop Synchronization

The central architectural challenge across Web and Desktop is ensuring **all workspace members can discover and access projects** while preventing machine-specific paths from corrupting shared data.

### 2.1 The Two-Layer Project Model
We decouple a project into two distinct operational layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│               SHARED CANONICAL ENTITY (Cloud: Supabase)                │
│  • Project ID, Name, Key ("EC-CHECK"), Description, Status, Dates     │
│  • Canonical Remote: https://github.com/my-org/checkout-service        │
│  • Specifications, Kanban Issues, PR Links, Squad Configurations       │
│  • Scope: Visible to ALL members of Workspace                          │
└───────────────────┬────────────────────────────────┬───────────────────┘
                    │                                │
     Synced via     │                                │ Synced via
     Supabase       ▼                                ▼ Supabase
┌──────────────────────────────────────┐  ┌──────────────────────────────┐
│    DEVELOPER ALICE (Mac Desktop)     │  │  DEVELOPER BOB (Win Desktop) │
│                                      │  │                              │
│ Local Binding (~/.alpha/alpha.db):   │  │ Local Binding (~/.alpha/..): │
│ • Path: /Users/alice/code/checkout   │  │ • Path: D:\Code\checkout     │
│ • State: Ready (Clean • main)        │  │ • State: Ready (Clean • dev) │
│ • Local AI: agy / claude             │  │ • Local AI: agy / ollama     │
└──────────────────────────────────────┘  └──────────────────────────────┘
```

1. **Shared Canonical Project (Cloud Supabase):**
   * Holds the project identity, metadata, roadmap milestones, and the canonical GitHub repository reference (`github_repo: https://github.com/org/repo`).
   * Contains **zero absolute machine paths**.
2. **Local Project Binding (Developer Desktop SQLite `~/.alpha/alpha.db`):**
   * Stored locally on each developer's hard drive in a dedicated table:
     ```sql
     CREATE TABLE local_project_bindings (
       project_id TEXT PRIMARY KEY,
       local_dir TEXT NOT NULL,
       is_managed INTEGER NOT NULL DEFAULT 1,
       active_branch TEXT,
       last_synced_at TEXT
     );
     ```
   * Alice's local path (`/Users/alice/...`) remains private to Alice. Bob's path (`D:\Bob\...`) remains private to Bob. Neither overwrites the other, and the Web app never encounters broken local paths.

### 2.2 Dual-Scope Project Visibility ("All Projects" vs. "My Projects")
To eliminate the friction where newly created projects are invisible to developers:
* **Default Workspace Read Access:** Every verified member of a workspace receives `project.read` across the workspace.
* **Dual Tab View in `ProjectsView.tsx`:**
  * **"My Projects" (Focused Work):** Shows projects where the user is an assigned developer in `workspace_project_assignments` or has open assigned issues/PRs.
  * **"All Workspace Projects" (Discovery):** Displays every project in the organization, allowing any developer to inspect requirements, view active squad runs, or self-assign.

### 2.3 The Developer "One-Click Clone & Bind" Workflow
When a developer opens any project in the Desktop App:

| Local Repository State | Desktop UI State | Available Action |
| :--- | :--- | :--- |
| **Not checked out on this machine** | Remote repository badge visible (`github.com/org/repo`). Status: `Remote Only`. | **[One-Click Clone & Setup]**<br>Clones to `~/.alpha/workspaces/<owner>/<repo>`, runs dependency install, and binds path. |
| **Already cloned elsewhere on disk** | Developer already has a working clone on their drive. | **[Link Existing Local Folder]**<br>Developer selects folder; verifies `.git` remote matches and saves local binding. |
| **Active & Ready** | Status: `Ready`<br>Local: `~/code/repo` (Clean • `main`). | **[Open Live Build Room]** or **[Run Agent]**<br>Autonomous agents execute directly in this working copy. |

### 2.4 Decoupling Project Permissions from Local Bindings
* **`project.manage` (Admin / PM):** Modifies global project name, milestones, repository bindings, or archives the project.
* **`workspace.bind_local` (All Developers):** Allows any workspace developer to clone or bind a local checkout on their own workstation without requiring administrative approval.

---

## 3. Persona Model & Role-Based Access Control (RBAC)

The platform integrates fine-grained, capability-based RBAC aligned with GitHub Organization teams:

```
                  ┌──────────────────────────────┐
                  │    GitHub Organization Auth  │
                  └──────────────┬───────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   `org/clients`  │    │ `org/engineers`  │    │ `org/managers`   │
│   Role: `client` │    │ Role: `dev`      │    │ Role: `pm`       │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │                       │                       │
         ▼                       ▼                       ▼
• Portal Overview       • My Work & Issues      • Project Delivery
• Specifications        • Live Build Room       • Roadmap & Milestones
• Client Messages       • Agent Studio & Squads • Team Roster & RBAC
• Intake Requests       • CI/CD & Deployments   • Operational Analytics
```

### 3.1 Role Capability Matrix

| Capability | Client | Developer (`dev`) | Project Manager (`pm`) | Admin |
| :--- | :---: | :---: | :---: | :---: |
| `workspace.read` | ✅ | ✅ | ✅ | ✅ |
| `workspace.manage_members` | ❌ | ❌ | ❌ | ✅ |
| `project.read` (Workspace-wide) | ✅ | ✅ | ✅ | ✅ |
| `project.create` & `manage` | ❌ | ❌ | ✅ | ✅ |
| `workspace.bind_local` (Desktop) | ❌ | ✅ | ✅ | ✅ |
| `issue.read` & `manage` | ❌ | ✅ | ✅ | ✅ |
| `agent.read` & `run` | ❌ | ✅ | ✅ | ✅ |
| `squad.manage` | ❌ | ✅ | ❌ | ✅ |
| `live_build_room.observe` | ❌ | ✅ | ✅ | ✅ |
| `deployment.read` & `manage` | ❌ | ✅ (Read) | ✅ | ✅ |

---

## 4. The Dual-Database Strategy

### 4.1 Why Cloudflare D1 Was Rejected
* `alpha-be-main` utilizes `better-sqlite3`, which relies on native C++ synchronous queries (`this.db.prepare().all()`).
* Cloudflare D1 is an asynchronous HTTP-based database (`await db.prepare().all()`). Moving to D1 would require rewriting over 2,100 lines of synchronous queries across [sqliteService.ts](file:///Users/lloyd/School%20Projects/Capstone/alpha-be-main/src/services/sqliteService.ts) and would introduce 100ms–300ms network latency per query from a Render container.

### 4.2 Polyglot Persistence Architecture
1. **Cloud Database (Supabase PostgreSQL):**
   * **Host:** Managed Cloud PostgreSQL (Always-On 24/7).
   * **Entities:** `workspaces`, `workspace_members`, `projects`, `workspace_project_assignments`, `issues`, `comments`, `agent_calls`, `squads`, `requirement_docs`.
   * **Realtime:** Emits `postgres_changes` over WebSocket channels to Web and Desktop clients.
2. **Local Database (Developer Desktop SQLite `~/.alpha/alpha.db`):**
   * **Host:** Developer's local hard drive via synchronous `better-sqlite3`.
   * **Entities:** `local_project_bindings`, `allowed_paths`, active process supervision PIDs, local model discovery caches (`localhost:11434`), and local secrets/env overrides.

---

## 5. Guarded Agent Call Lifecycle & Patch Management

Direct, unchecked code execution on shared repositories introduces high risk. The platform implements a formal multi-stage state machine via [agentCallService.ts](file:///Users/lloyd/School%20Projects/Capstone/alpha-be-main/src/services/agentCallService.ts):

$$\text{create} \longrightarrow \text{awaiting\_confirmation} \longrightarrow \text{queued} \longrightarrow \text{running} \longrightarrow \text{completed / failed}$$

### 5.1 Guarded Operation Modes
* **Read-Only Modes (`investigate`, `architect`, `review`):**
  * Agents run without write permissions. Results return strictly as markdown artifacts or recommendations.
* **Mutating Mode (`implement`):**
  * The call immediately enters `awaiting_confirmation`.
  * The agent generates a **unified git patch artifact** (up to 2MB limit) rather than directly modifying disk files.
  * The proposed diff is rendered in the UI ([ChatView.tsx](file:///Users/lloyd/School%20Projects/Capstone/alpha-fe-main/src/features/chat/ChatView.tsx) or [LiveBuildRoomView.tsx](file:///Users/lloyd/School%20Projects/Capstone/alpha-fe-main/src/features/live-build-room/LiveBuildRoomView.tsx)).
  * Upon explicit user/developer confirmation, the desktop runner applies the patch via `git apply`, runs local tests, and prepares the commit.

---

## 6. The Live Build Room Real-Time Collaboration Bridge

The **Live Build Room** ([LiveBuildRoomView.tsx](file:///Users/lloyd/School%20Projects/Capstone/alpha-fe-main/src/features/live-build-room/LiveBuildRoomView.tsx) & [liveBuildRoomController.ts](file:///Users/lloyd/School%20Projects/Capstone/alpha-be-main/src/controllers/liveBuildRoomController.ts)) serves as the primary observation surface shared between Web and Desktop:

```
[ Developer Desktop Runner ]
  • Executes Squad Run (Architect ➔ Dev ➔ Reviewer ➔ Tester)
  • Publishes stage transitions & agent turn handoffs
                │
                │ (Supabase Realtime Channel: `run:${runId}`)
                ▼
[ Web App (PM) & Desktop (Dev) Live Build Room ]
  • Dynamic Squad Cards: Active agent card glows & animates
  • Real-Time Stage Trackers: Requirements ➔ Architecture ➔ Implementation ➔ Review ➔ Verification
  • Live Activity Feed & Diff Inspector: Sub-200ms latency without terminal emulation
```

---

## 7. Desktop App Packaging, Distribution & Auto-Updates

* **Binary Distribution:** Built with `electron-builder`:
  * Windows: `Alpha-Setup.exe` (NSIS) or portable `.exe`.
  * macOS: `Alpha.dmg` / Universal binary (`.app`).
  * Linux: `Alpha.AppImage` / `.deb`.
* **Zero-Disruption Auto-Updates:** Powered by `electron-updater`:
  * Releases hosted on GitHub Releases.
  * Reuses developer's existing `gh auth token` for private release downloads.
  * Downloads silently in the background; prompts developer to restart when idle, never interrupting an active agent run.

---

## 8. Authentication, GitHub Identity & Team Scoping

### 8.1 Why Not Google Auth?
Google Auth provides only email identity. It lacks repository scopes, cannot verify GitHub Organization team memberships, cannot create branches, and cannot sign Pull Requests.

### 8.2 GitHub Identity Integration
* **Desktop Developers:** Automatic zero-click authentication by detecting existing credentials from the GitHub CLI (`gh auth token`). Fallback to browser OAuth deep link (`alpha://auth/callback`).
* **Web Users (PM / Client):** Supabase Auth with GitHub Provider. Maps team membership:
  * `org/project-managers` $\rightarrow$ `role: "pm"`
  * `org/engineers` $\rightarrow$ `role: "dev"`
  * External invited users $\rightarrow$ `role: "client"`

---

## 9. Phase-by-Phase Implementation Roadmap

The execution is structured into **5 distinct phases**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       5-PHASE IMPLEMENTATION ROADMAP                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  PHASE 1: Database & Schema Separation (Supabase Cloud + Desktop SQLite)    │
│  PHASE 2: Backend API & Permission Refinement (alpha-be-main)               │
│  PHASE 3: Developer Desktop Local Binding Engine (alpha-desktop & Runner)   │
│  PHASE 4: Frontend UI, Project Discovery & Realtime Sync (alpha-fe-main)    │
│  PHASE 5: End-to-End Client Project CI/CD & Production Verification        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 1: Database & Schema Separation
* **Objective:** Establish clean persistence boundaries between shared cloud entities and private desktop bindings.
* **Tasks:**
  1. **Supabase Cloud Schema Migration:** Create PostgreSQL migration script for:
     * `workspaces`, `workspace_members`, `projects`, `workspace_project_assignments`, `issues`, `agent_calls`, `requirement_docs`.
  2. **Desktop SQLite Schema Update (`~/.alpha/alpha.db`):**
     * Create `local_project_bindings` table (`project_id`, `local_dir`, `is_managed`, `active_branch`, `last_synced_at`).
     * Ensure `allowed_paths` automatically tracks all local bound directories.
  3. **Data Sanitization:** Strip any machine-specific paths from shared project resource records.

### Phase 2: Backend API & Permission Refinement (`alpha-be-main`)
* **Objective:** Enable workspace-wide project discovery and decouple local desktop bindings from global admin rights.
* **Tasks:**
  1. **Update `workspaceRegistry.ts`:**
     * Modify `canAccessProject` and `scopeProjects`: Grant `project.read` for all workspace members so developers can discover all projects.
     * Add `workspace.bind_local` capability to `dev`, `pm`, and `admin` roles.
  2. **Refactor `dataController.ts`:**
     * Change `/projects/check-workspace` authorization requirement from `project.manage` to `workspace.bind_local`.
     * Add dedicated endpoints:
       * `GET /api/projects/:id/binding` (Resolves local binding on Desktop).
       * `POST /api/projects/:id/binding` (Saves local binding in local SQLite).
  3. **Integrate with `agentCallService.ts`:**
     * Update `resolveProjectWorkspace` to check `local_project_bindings` first before falling back to managed clone paths.

### Phase 3: Developer Desktop Local Binding Engine (`alpha-desktop` & Runner)
* **Objective:** Provide a seamless, automated clone and folder-binding experience on developer machines.
* **Tasks:**
  1. **Automated One-Click Clone Service:**
     * Implement `cloneAndBindProject(project)`: Spawns local `git clone <repoUrl> ~/.alpha/workspaces/<owner>/<repo>`, validates repo integrity, and records local binding.
  2. **Link Existing Directory Workflow:**
     * Implement folder selector dialog and `.git` origin verification against the canonical GitHub URL.
  3. **Local Status Heartbeat:**
     * Expose local working copy health (clean working tree, current branch, unpushed commits) to the desktop UI.

### Phase 4: Frontend UI, Project Discovery & Realtime Sync (`alpha-fe-main`)
* **Objective:** Deliver the dual-scope project UI and wire real-time event broadcasting between Web and Desktop.
* **Tasks:**
  1. **Dual-Scope Project Tabs (`ProjectsView.tsx`):**
     * Add toggle: **"My Projects"** (assigned) vs. **"All Projects"** (workspace catalog).
  2. **Smart Project Workspace Card (`AttachWorkspaceForm.tsx` refactor):**
     * On Desktop: Display local path, branch status, and **[Clone & Setup]** or **[Link Folder]** actions.
     * On Web: Display canonical GitHub link, active assignees, and live telemetry badge.
  3. **Supabase Realtime Channel Wiring:**
     * Subscribe to `workspace:${workspaceId}:projects` and `workspace:${workspaceId}:issues`.
     * Instantly reflect new projects, status changes, and Kanban transitions across all connected clients.
  4. **Live Build Room Stage Streaming:**
     * Verify [LiveBuildRoomView.tsx](file:///Users/lloyd/School%20Projects/Capstone/alpha-fe-main/src/features/live-build-room/LiveBuildRoomView.tsx) receives real-time agent handoffs and stage updates from active desktop runs.

### Phase 5: End-to-End Client Project CI/CD & Production Verification
* **Objective:** Verify client project scaffolding, automated GitHub Actions CI/CD pipelines, and preview deployments.
* **Tasks:**
  1. **Client Project CI/CD Scaffolding:**
     * Validate [repoScaffoldService.ts](file:///Users/lloyd/School%20Projects/Capstone/alpha-be-main/src/services/repoScaffoldService.ts) automatically generates `.github/workflows/ci.yml` and preview deployment triggers for Vercel/Render.
  2. **Deployments View Verification:**
     * Confirm [DeploymentsView.tsx](file:///Users/lloyd/School%20Projects/Capstone/alpha-fe-main/src/features/deployments/DeploymentsView.tsx) tracks GitHub Actions runs, exposes preview URLs, and triggers AI healing on pipeline failures.
  3. **Multi-Client Production Test:**
     * Verify end-to-end flow: PM creates project on Web $\rightarrow$ Developer clones on Desktop $\rightarrow$ Agent implements issue with diff patch $\rightarrow$ Dev approves $\rightarrow$ CI/CD tests pass $\rightarrow$ PM inspects preview deployment.

---

## 10. Summary Decision Matrix

| Dimension | Architectural Decision | Primary Rationale |
| :--- | :--- | :--- |
| **System Architecture** | Hybrid Cloud Control Plane + Local Execution Node | PM gets zero-install cloud SaaS; Dev gets native filesystem power & local AI. |
| **Project Model** | Decoupled Canonical Cloud Project vs. Local Desktop Binding | Eliminates path collisions across machines; enables multi-developer collaboration. |
| **Project Visibility** | Dual-Scope: "All Projects" (Discovery) + "My Projects" (Focus) | Every team member can discover projects while maintaining daily focus. |
| **Workspace Binding** | `workspace.bind_local` granted to all Developers | Developers can clone and bind local folders without requiring PM administrative rights. |
| **Database Division** | Supabase Postgres (Cloud) + SQLite (Local Desktop) | Preserves 2,100+ lines of synchronous SQLite; zero latency for local execution. |
| **Agent Execution** | Guarded Agent Call Lifecycle (`agentCallService.ts`) | Generates unified git patches before applying; guarantees auditability. |
| **Collaboration Bridge** | Live Build Room (`LiveBuildRoomView.tsx`) | Shared real-time canvas for observing multi-agent squad handoffs and diffs. |
| **Hosting Strategy** | Vercel (Web Frontend) + Render (API) + Supabase (DB/Realtime) | High availability, zero server maintenance, and fast edge distribution. |
| **Desktop Shell** | Electron (`alpha-desktop`) with `electron-updater` | Direct hardware/CLI access with seamless background updates via GitHub Releases. |
| **Authentication** | Pure GitHub OAuth & `gh` CLI Token Detection | Direct mapping to GitHub Organization teams, repository rights, and PR workflows. |
