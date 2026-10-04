---
name: amdahl
description: The map of what Amdahl can do and which tool, CLI command or API call does each job. Use when a user asks "what can I do with Amdahl?", "what else can this do?", "how do I use Amdahl?" or "which tool do I use for X?", or before you pick an Amdahl tool for a new kind of request. Answer from this map instead of running tools or commands to find out.
---

# What Amdahl can do

Amdahl improves the outbound your team and your agents write. Send one draft and get a stronger version back in the sender's own voice, with no data connected. Connect your conversations to also check its claims against what your customers said.

You reach it three ways: the MCP server (`https://app.amdahl.ai/mcp`, six tools, each with an `action`), the `amdahl` CLI, and the REST API (`https://app.amdahl.ai/api/platform/v1`).

## The rules

- **Answer "what can I do?" from the table below.** Do not run tools, CLI commands or API calls to discover capabilities. Listing tools or calling each one to see what it does wastes the user's time and quota.
- **For anything not in the table, read the docs before you call a tool.** Start at `https://docs.amdahl.ai/llms.txt` (an index of every page). Every page also has a markdown twin: add `.md` to its URL, for example `https://docs.amdahl.ai/cli.md`.
- **Check setup once, before the first real action.** Over MCP, call `connections` with `{"action": "setup_status"}`. In a terminal, run `amdahl status`. Over REST, `GET /setup/status`. If something is blocked, tell the user the fix it names. Do not check again unless the user changes something.
- **Prefer the cheapest read.** A question about customers is a `search` first. Use `research` or a Chat only when one search cannot answer it.
- **Do not spend or create without a request.** Never create or revoke a key, run an eval, optimize a draft, start research or a Chat, or connect a source unless the user asked for that.

## The map

Rows marked "needs data" read the workspace's synced calls, CRM accounts and deals. With nothing synced they return empty results, not errors.

| The user wants to | MCP tool and action | CLI | REST | Say it like | Docs |
| --- | --- | --- | --- | --- | --- |
| Improve one outbound email or LinkedIn message (no data needed) | `messages` → `optimize` | `amdahl optimize draft.md` | `POST /messages/optimize` | "Optimize this email." | [Message Optimizer](https://docs.amdahl.ai/endpoints/message-optimizer) |
| Check a draft's claims against what customers said (needs data) | `messages` → `optimize` with `evidence: "workspace"` | `amdahl optimize draft.md --evidence workspace` | `POST /messages/optimize` | "Optimize this and flag anything our customers never said." | [Check claims](https://docs.amdahl.ai/cookbooks/check-claims-against-your-customers) |
| Grade a draft or prompt and get an improved version (needs data) | `evals` → `run`, then `status` | none | `POST /evals/run`, then `GET /eval-runs/{id}` | "Grade this cold email against our customer calls." | [Evals API](https://docs.amdahl.ai/endpoints/evals) |
| Answer a question about customers, calls or deals in one fast call (needs data) | `search` → `query` (`fields` lists what can be filtered) | none | `POST /search/query` | "What objections came up in lost deals last quarter?" | [Search](https://docs.amdahl.ai/endpoints/search) |
| See what data the workspace holds (needs data) | resource `search-overview://current` | none | `GET /search/overview` | "What data does Amdahl have for us?" | [Search overview](https://docs.amdahl.ai/endpoints/search#check-what-is-there-first-search-overview) |
| Investigate one question and get one cited answer (needs data) | `research` → `start`, then `status` | none | `POST /research`, then `GET /research/{id}` | "Why are we losing to our top competitor?" | [Research](https://docs.amdahl.ai/endpoints/research) |
| Have an agent write a deliverable or do a multi-step job (needs data) | `agents` → `start_chat`, then `chat_status` | none | `POST /chat` | "Write a win/loss brief for this quarter." | [Chat](https://docs.amdahl.ai/chat) |
| Save a reusable agent | `agents` → `list_agents`, `create_agent` | none | `/agents` | "Save this as an agent called Deal Reviewer." | [Agents](https://docs.amdahl.ai/agents) |
| Run a Chat on a schedule | `agents` → `create_routine`, `run_routine_now` | none | `/routines` | "Every Monday, summarize last week's pipeline." | [Routines](https://docs.amdahl.ai/routines) |
| Check setup: role, optimize quota, connections needing attention | `connections` → `setup_status` | `amdahl status` | `GET /setup/status` | "Is my Amdahl setup working?" | [Check your setup](https://docs.amdahl.ai/endpoints/connections#check-your-setup) |
| See or manage connected sources (CRM, call recorders) | `connections` → `list`, `catalog`, `status`, `connect`, `reconnect` | none | `/connections` | "Which sources are connected, and are they healthy?" | [Connections](https://docs.amdahl.ai/endpoints/connections) |
| Sign in from a terminal, see who you are | none | `amdahl login`, `amdahl whoami`, `amdahl logout` | none | "Sign me in to Amdahl." | [CLI](https://docs.amdahl.ai/cli) |
| Create, list or revoke an API key for a server or CI (approved in the console) | none | `amdahl keys create`, `amdahl keys list`, `amdahl keys revoke` | none | "Make me a key for our CI job." | [CLI: API keys](https://docs.amdahl.ai/cli#api-keys-for-servers-and-ci) |
| Connect Claude Code, Codex or Cursor | none | `amdahl install claude-code` (or `codex`, `cursor`) | none | "Add Amdahl to Cursor." | [Connect your agent](https://docs.amdahl.ai/mcp/connect-agent) |

`research`, `evals` and Chats are asynchronous: the start call returns an id, and the status call with `wait_ms` waits for the answer. Do not write your own sleep loop.

Each tool has more actions than this table shows (reading past runs, feedback on an eval, Subscriptions, editing routines). The full list per tool is in [Connect your agent](https://docs.amdahl.ai/mcp/connect-agent#what-your-agent-gets). Every operation, with the scopes and role it needs, is in the [tool catalog](https://docs.amdahl.ai/api-reference/tool-catalog).

## If a call is refused

A refusal names its reason. Run the setup check above and tell the user the fix:

- **Missing scope.** A Read only key can search and read, but cannot optimize, run evals, start research or start a Chat. The user needs a Customer agent key (`amdahl keys create --preset agent`) or to reconnect their client.
- **Role too low.** A Viewer needs a workspace admin to make them an Editor.
- **Quota used up.** Optimizations and research have monthly caps. `setup_status` says when the optimize cap resets.

## Go deeper

- [Optimizer skill](https://docs.amdahl.ai/skills/amdahl-optimizer/SKILL.md): a first optimize run, step by step.
- [Onboarding skill](https://docs.amdahl.ai/skills/amdahl-onboarding/SKILL.md): a full first run, from connecting to a graded eval.
- [Use cases](https://docs.amdahl.ai/concepts/use-cases): GTM jobs mapped to the calls that serve each one.
- [Every call at a glance](https://docs.amdahl.ai/endpoints): REST paths, MCP actions, scopes and latency.
- [CLI](https://docs.amdahl.ai/cli) and [tool catalog](https://docs.amdahl.ai/api-reference/tool-catalog).
- [llms.txt](https://docs.amdahl.ai/llms.txt): every docs page, one line each.
