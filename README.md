# Anywhere

Describe what you want to do. Anywhere works out the compute it needs, shows you what it will cost,
provisions a real GPU machine on NVIDIA Brev, sets it up, and can operate it for you. You can watch
it work in the browser or text it over iMessage.

Built for HackUTD ZeroDay around **NVIDIA Nemotron + Brev**, **SpacetimeDB** and **Photon**.

---

## Architecture

```
                   ┌──────────── browser (Next.js) ────────────┐        iMessage
                   │ workspace · desktops · workloads · settings│           │
                   └───────┬───────────────────────┬────────────┘           │
         live subscriptions│ (my_* views)          │ HTTPS commands + VNC   │
                           ▼                       ▼                        ▼
              ┌────────────────────┐   ┌────────────────────────┐  ┌──────────────────┐
              │    SpacetimeDB     │◄──│     control plane      │◄─│ messaging bridge │
              │  system of record  │   │  FastAPI · LangGraph   │  │  spectrum-ts     │
              │  views · reducers  │──►│  Nemotron · planner    │  │  (Photon)        │
              │  lifecycle rules   │   │  budget · supervisor   │  └────────┬─────────┘
              └────────────────────┘   └───────┬────────┬───────┘           │
                     ▲  worker_outbox ─────────┼────────┼───────────────────┘
                     │                         │ brev   │ ssh tunnel (VNC, Cua :3211)
                     │                         ▼        ▼
                     │                ┌──────────────────────────┐   ┌─────────────────┐
                     └─ status/logs ──│  NVIDIA Brev GPU instance │──►│ S3-compatible   │
                        metrics       │  Docker · Cua desktop     │   │ object storage  │
                                      │  Blender / training job   │   │ projects, data, │
                                      └──────────────────────────┘   │ checkpoints     │
                                                                     └─────────────────┘
```

It's a modular monolith with one central agent.

| Piece | Path | Role |
|---|---|---|
| SpacetimeDB module | `spacetime/module` | The system of record. Every table is private: browsers read their own rows through `my_*` views, and services read through worker-only `worker_*` views. Reducers enforce the workload lifecycle, monotonic spend, and ownership. Users can only change their own preferences and desktop control; anything that spends money goes through the control plane. |
| Client bindings | `spacetime/bindings` | `@anywhere/stdb`, typed tables, views and reducers shared by the web app and the bridge. It's hand-written in `spacetime generate`'s format, so regenerating overwrites it in place. |
| Control plane | `services/control` | FastAPI on Python 3.13. Details in the list below the table. |
| Web | `apps/web` | Next.js 16, Tailwind v4 and Base UI primitives with a hand-built design system and icon set. It renders entirely from live SpacetimeDB subscriptions. |
| Messaging bridge | `services/messaging` | A TypeScript service using Photon Spectrum. Inbound iMessages go to the control plane, and queued notifications come back out from the SpacetimeDB outbox. |
| Deploy | `deploy/` | Docker Compose and Caddy for a single general-purpose VM (639Cloud). |

What the control plane does:
- **Nemotron agent.** A LangGraph agent with typed tools that turns the conversation into a structured `Intent`.
- **Deterministic planner.** Sizes hardware from a curated Brev catalog and estimates cost from real prices. The model never invents specs.
- **Budget policy.** Enforces three layers of guardrails: platform, account, and per-plan.
- **Supervisor.** Provisions, configures, saves, stops, resumes, cleans up and reconciles machines.
- **Cua computer-use operator.** Drives the desktop.
- **Authenticated VNC proxy.** Relays the desktop stream to the browser.

### Request flow: "Set up a Blender desktop"

1. The browser `POST /v1/chat`. The control plane appends the message through a reducer, and every open tab sees it instantly.
2. The Nemotron agent extracts an `Intent`. The planner validates it, picks an offer from the catalog, and estimates a cost range with an honest confidence level.
3. The budget policy checks it. A `planned` workload and a plan card appear in the thread.
4. The user approves. The supervisor runs `brev create`, waits for the machine, runs a checksum-verified setup script (Docker, Cua Linux desktop, Blender), restores the saved project from S3, and moves the workload through `provisioning → configuring → running`.
5. The browser opens the desktop. It gets a 60-second HMAC ticket, and the control plane relays noVNC over an SSH tunnel to the instance's loopback-only VNC server. The VM is never exposed.
6. "Make a low-poly tree" starts the operator loop: screenshot → Nemotron vision picks one action → Cua executes it → verify. Each step streams into `agent_step`. **Take over** stops the run and makes the stream interactive. **Hand to agent** resumes it.
7. **Stop** copies `~/Projects` to S3 before stopping the machine. Billing pauses, and **Resume** restores it.

### Safety and budget

- `PROVISIONING_MODE` defaults to `disabled`. `dry_run` validates with Brev without billing, and only `live` creates machines.
- **Platform:** a global budget (default $50 of the $60 credit) and a concurrency cap (default 1).
- **Account:** a monthly cap, at most $50. **Per plan:** anything above the user's auto-approve threshold waits for an explicit approval. The default threshold of $0 means always ask.
- **Guard loop (every 30 s):**
  - accrues spend and stops idle desktops (default 20 min);
  - enforces the max session length and budget exhaustion;
  - reconciles orphaned Brev instances;
  - recovers in-flight work after a restart.
- Spend recorded in SpacetimeDB is monotonic: a stale writer can never lower it.
- Every failed launch is cleaned up. Projects are saved before any stop or delete.
- Provider keys live only on the server. Browsers authenticate with their SpacetimeDB token, which the control plane verifies with SpacetimeDB.

---

## Capability status

**Verified** means exercised end to end against real services. **Tested** means covered by automated tests with fakes. **Built** means implemented but not yet run against the real provider, because the keys or credits aren't connected yet.

| Capability | Status | Notes |
|---|---|---|
| SpacetimeDB schema, views, reducers, lifecycle | **Verified** | Published to a SpacetimeDB 2.14.1 server; 10 vitest tests |
| Browser identity → control-plane auth | **Verified** | Token verified through SpacetimeDB `/v1/identity/{id}/verify` |
| Onboarding (name, invite code), realtime gate | **Verified** | |
| Chat → message persistence → live thread | **Verified** | |
| Deterministic planner, catalog, cost estimate, plan card | **Verified** | Driven with a structured intent; planner and budget have unit tests |
| Approve → supervisor launch → cleanup on failure | **Verified** | With no Brev key: refused, cleaned up, user told why |
| Boot progress, live cost ticker, workload/desktop pages | **Verified** | Lifecycle stepped through real reducers |
| Budget policy, lifecycle mirror, supervisor guard and cleanup | **Tested** | 59 pytest tests |
| Nemotron intent extraction and agent tools | Built | Needs `NVIDIA_API_KEY` |
| Brev provisioning, stop/resume, reconcile | Built | Needs `BREV_API_KEY` and approval before spending credits |
| Desktop on Brev (Cua Linux image, Blender, x11vnc/websockify) | Built | Not yet run on a Brev GPU. Xvfb has no hardware GL, so viewport rendering is software and Cycles renders use the GPU via CUDA/OptiX |
| Cua computer-use operator | **Tested** | Fakes for screen and model; not yet run on a live desktop |
| noVNC stream through the ticketed proxy | Built | Needs a running desktop |
| S3 projects, uploads, artifacts | Built | Needs bucket credentials (R2 recommended) |
| LoRA/QLoRA training job, metrics, artifacts | **Tested** | Config and dataset inspection tested; GPU run pending |
| Photon iMessage bridge (inbound, outbound, linking) | Built | Typechecks; needs a Photon project |
| MCP server for external agents, scoped tokens | **Tested** | 22 pytest tests over real HTTP with the SDK client; smoke-tested against a local server |
| Docker images and Compose | **Verified** | Images build locally |

**Not supported yet:** Windows-only apps (Roblox Studio and others), Unity/Unreal (Linux builds are untested), inference/API deployment, render farms, multi-GPU jobs, and providers other than Brev.

---

## Running locally

Prerequisites: Node 22.12 or newer with pnpm 10 (older Node can't load Tailwind's dev build), Python 3.13 with [uv](https://docs.astral.sh/uv/), and Docker.

```bash
pnpm install
cd services/control && uv sync && cd ../..
```

**1. SpacetimeDB.** Run the 2.14.1 server in Docker and publish the module. The container needs Node to build the TypeScript module.

```bash
docker run -d --name anywhere-stdb -p 3100:3000 -v "$PWD":/repo clockworklabs/spacetime:v2.14.1 start
docker exec -u root anywhere-stdb sh -c 'apt-get update -qq && apt-get install -y -qq curl && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs'
docker exec anywhere-stdb sh -c 'spacetime server set-default local && cd /repo/spacetime/module && spacetime publish anywhere -y'
```

If you have the `spacetime` CLI installed locally, `pnpm --filter @anywhere/spacetime-module publish:local` works too.

**2. Control plane worker identity.** Mint an identity, then allowlist it as the database owner:

```bash
cd services/control && cp .env.example .env
SPACETIME_HOST=http://127.0.0.1:3100 uv run anywhere identity
docker exec anywhere-stdb spacetime sql anywhere "INSERT INTO worker (identity, label) VALUES (0x<identity>, 'control')"
```

Put the printed token in `SPACETIME_WORKER_TOKEN` in `services/control/.env`.

**3. Run the control plane and the web app.**

```bash
cd services/control && uv run anywhere serve --port 8000
```

```bash
cp apps/web/.env.example apps/web/.env.local && pnpm dev:web
```

Open http://localhost:3000. In development with no `INVITE_CODE` set, any invite code works.

**4. (Optional) iMessage bridge.** Fill in `services/messaging/.env`, then run:

```bash
pnpm --filter @anywhere/messaging dev
```

### Tests

```bash
cd services/control && uv run pytest && uv run ruff check src tests
```

```bash
pnpm --filter @anywhere/spacetime-module test
```

```bash
pnpm -r typecheck && pnpm --filter web lint
```

---

## Using Anywhere from Claude and other agents (MCP)

The control plane is also an [MCP](https://modelcontextprotocol.io) server at `/mcp` (`https://$DOMAIN/api/mcp` behind Caddy). Any MCP client that speaks Streamable HTTP can plan, run and operate machines with it.

1. In **Settings → Agents**, create a token and choose its permissions. The token is shown once.
2. Add the server to your client. For Claude Code:
   ```bash
   claude mcp add --transport http anywhere https://$DOMAIN/api/mcp \
     --header "Authorization: Bearer awmcp_…"
   ```

| Permission | Tools |
|---|---|
| `read` | `get_account`, `get_catalog`, `list_workloads`, `get_workload` |
| `plan` | `propose_workload`, `cancel_plan` |
| `control` | `stop_workload`, `save_project`, `delete_workload` (needs `confirm: true`), `operate_desktop`, `stop_desktop_agent` |
| `spend` | `approve_workload`, `resume_desktop` |

New tokens get `read`, `plan` and `control`. **Without `spend`, an agent can't start anything that bills:** its plans skip your auto-approve threshold and wait for you to approve them in the web app. Every plan and action an agent takes shows up in an "Agent: <token name>" conversation.

How it's secured:
- Tokens are bound to one account and stored only as SHA-256 hashes in the control plane's vault. They expire (90 days by default, at most `MCP_MAX_TOKEN_DAYS`), and revoking one takes effect on the next request.
- Tokens can only be created, listed or revoked with a browser identity, so an MCP token can't mint more tokens.
- The server runs stateless, so every request is authenticated on its own. Requests with a foreign `Origin` are refused (DNS rebinding and CSRF), bodies are capped at 256 KB, and each token is rate-limited per permission.
- Tool calls go through the same `Anywhere` methods as the web app, so ownership, lifecycle and budget rules apply unchanged. Calls are capped at 45 s, and errors come back as short messages without internals. Details go to the server log.
- `MCP_ENABLED=false` turns the endpoint off.

Not yet: OAuth (needed to add Anywhere as a claude.ai connector), live desktop streaming over MCP, and agent step history in `get_workload`, which needs a `worker_*` view for agent runs.

---

## Environment variables

`deploy/.env.example` lists every option. The main ones:

| Variable | Service | Purpose |
|---|---|---|
| `SPACETIME_HOST`, `SPACETIME_DATABASE` | control, bridge | SpacetimeDB HTTP base URL and database name |
| `SPACETIME_WORKER_TOKEN` | control, bridge | Token of an allowlisted worker identity |
| `NEXT_PUBLIC_SPACETIME_HOST` / `SPACETIME_PUBLIC_URL` | web | WebSocket URL browsers use (fixed at build time) |
| `NEXT_PUBLIC_API_URL` | web | Control plane base URL: `/api` behind Caddy, `http://localhost:8000` locally |
| `PROVISIONING_MODE` | control | `disabled` (default), `dry_run`, or `live` |
| `GLOBAL_BUDGET_CENTS`, `MAX_CONCURRENT_INSTANCES`, `MAX_SESSION_HOURS`, `DESKTOP_IDLE_MINUTES` | control | Platform guardrails |
| `INVITE_CODE` | control | Required to activate accounts outside development |
| `NVIDIA_API_KEY`, `PLANNER_MODEL`, `VISION_MODEL` | control | Nemotron on build.nvidia.com |
| `BREV_API_KEY` | control | Brev CLI authentication |
| `S3_ENDPOINT_URL`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | control | Durable storage for projects, datasets and outputs |
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | control, bridge | Photon project |
| `MESSAGING_BRIDGE_SECRET` | control, bridge | Shared secret for `/v1/bridge/inbound` |
| `MCP_ENABLED`, `MCP_MAX_TOKENS_PER_ACCOUNT`, `MCP_MAX_TOKEN_DAYS` | control | MCP server switch and token limits |

---

## Deploying (639Cloud VM)

639Cloud sells dedicated VMs with root access and custom OS images. That's all Anywhere needs, because GPU work runs on Brev and state lives in SpacetimeDB.

1. Provision a VM with **2 vCPU / 4 GB / 40 GB** running Ubuntu 24.04. Add your SSH key and confirm it has a public IPv4 address (the site doesn't say whether one is included). Point `DOMAIN` at it and open ports 80 and 443.
2. Install Docker: `curl -fsSL https://get.docker.com | sh`.
3. Publish the module to **SpacetimeDB Maincloud**:
   ```bash
   spacetime login
   pnpm --filter @anywhere/spacetime-module publish:maincloud
   ```
   Then mint and allowlist a worker identity as in local step 2, using `SPACETIME_HOST=https://maincloud.spacetimedb.com`.
4. Configure and start:
   ```bash
   git clone https://github.com/SakethSripada/Anywhere && cd Anywhere
   cp deploy/.env.example deploy/.env   # fill it in
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   # add --profile messaging once Photon is configured
   ```
5. Authenticate Brev inside the control container once. Its state persists in the `brev_home` volume:
   ```bash
   docker compose -f deploy/docker-compose.yml exec control brev login --token "$BREV_API_KEY"
   ```

Caddy provisions TLS automatically. It routes `/api/*` (including the long-lived VNC WebSockets) to the control plane and everything else to the web app.

---

## Limitations and next steps

- The Brev desktop and training paths haven't run on a real GPU yet. The first live test needs explicit approval because it spends credits. Start with a T4 or L4 in `dry_run`, then `live` with a $5 global budget.
- GPU-accelerated *viewport* rendering needs TurboVNC with VirtualGL. The current desktop uses Xvfb and x11vnc, so viewport rendering is software. GPU compute (Cycles, CUDA) is unaffected.
- One provider (Brev) and one desktop template (Blender on Linux).
- Bindings are hand-maintained until the `spacetime` CLI runs in CI. Run `pnpm --filter @anywhere/spacetime-module generate` after schema changes.
- Voice interaction over Photon isn't implemented.
