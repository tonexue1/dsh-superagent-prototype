# OpenCode workers

This fork adds an optional OpenCode execution backend. Sources, admission, the main DSH orchestrator, Tickets, subscriptions and outbound replies remain in Super-agent. OpenCode owns each external worker's model/tool loop.

The default is still DSH. In **Execution → Settings**, choose **OpenCode**, enter its server URL, and optionally enter the OpenCode provider and model IDs. Leaving both IDs empty uses OpenCode's default model. The existing DSH worker model setting does not configure OpenCode.

## Run a server

Install and configure OpenCode using its [official documentation](https://opencode.ai/docs/). Configure a model in OpenCode or run `opencode auth login` there; a DSH model login is not automatically an OpenCode login.

Start a dedicated local server:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

Use `http://127.0.0.1:4096` in the panel. The adapter uses the documented HTTP API, so there is no new production SDK dependency. It was exercised against OpenCode **1.19.5**.

When using OpenCode Server basic authentication, set the same `OPENCODE_SERVER_PASSWORD` in the server and Super-agent processes. `OPENCODE_SERVER_USERNAME` defaults to `opencode`. Do not put credentials in the URL or panel settings. The adapter rejects URL credentials, queries, fragments, and non-HTTP protocols, and refuses redirects.

The server runs tools as its own OS user. It is not a sandbox. Use a dedicated local server with the same repository access and intended GitHub identity as the DSH deployment. To use the deployment's `gh`, `git` and `lark-cli` shims, start it with `<stateDir>/worker-bin` prepended to `PATH`, `GIT_CONFIG_GLOBAL=<stateDir>/worker-gitconfig`, `GIT_CONFIG_NOSYSTEM=1`, and `GIT_TERMINAL_PROMPT=0`; remove ambient `GH_TOKEN`, `GITHUB_TOKEN`, Git repository-location variables and git identity/config overrides. The preparation command continues to run through DSH's existing worker environment.

## Routing and lifecycle

- `executor.backend` selects the backend for newly accepted Tickets. The backend is persisted on `ticket.execution.backend`. Older records without this field use DSH.
- Switching the default never migrates an existing Ticket or conversation. Both backends can coexist, sharing the configured capacity for new launches. Like native DSH workers, human follow-ups can use one extra wake slot.
- Each external Ticket owns one OpenCode session. Its server URL, directory and model are pinned in the SQLite binding, so later global configuration changes do not move it to a different server. A missing/deleted session fails visibly rather than silently discarding context.
- Original requests and follow-ups are delivered with their original text and provenance. Inputs are serialized within the Ticket; incoming follow-ups wait for the current external turn.
- The adapter supplies the worker prompt, mandate and original requests. It asks for a JSON-schema report and validates it before invoking the same reporting tool used by native workers. Ordinary prose does not count as successful completion.
- Reports support `progress`, `ready`, `blocked`, `failed`, `dropped`, human questions, answers to explicit questions, and PR claims. PR claims go through the existing ownership checks. Reports and questions return through the main Session and the original Source.
- A `handbacks` array returns out-of-scope messages to the existing evaluation machinery; it does not authorize the external worker to perform them.
- Human stops and host shutdown explicitly call the remote session's abort API as well as cancelling the HTTP request. A late result cannot overwrite a stopped or superseded Assignment. Stops are sent only after the domain transaction commits.
- Restart/retry reuses the binding and conversation, aborts stale execution, and supplies a recovery reminder to inspect existing work. Stable message IDs and remote message history avoid replaying an already-completed request. A partially delivered turn without a recoverable result becomes a visible failure requiring a retry; the adapter does not blindly replay uncertain external actions.

## Current boundaries

This is an opt-in backend, not an exact reproduction of every native DSH tool. Native `orchestrator_*` tools are not installed in OpenCode. Communication uses the structured final report; real-time intermediate reports and native image/context-reader tools are not bridged. OpenCode's interactive question tool is disabled; workers use `human_action` instead. Sessions have the same broad execution authority as the existing DSH worker preset, so routine tool approvals do not wait on an unattended TUI.

DSH `blockedCommands` shims cannot be guaranteed for a separately running server. Every new OpenCode turn therefore refuses to start when this list is non-empty, including turns in existing sessions; configure and enforce a corresponding OpenCode policy before enabling this backend. No automatic shell-command retry is performed after an uncertain external failure. A failed task can be retried explicitly from the existing panel.

Completed Tickets can resume through normal subscriptions and retain their OpenCode conversation. The panel suppresses DSH session buttons for these Tickets; their external session ID and server URL are available in the Ticket API.

## Validate

```sh
pnpm check
OPENCODE_TEST_BIN=/absolute/path/to/opencode pnpm exec vitest run tests/opencode-live.spec.ts
```

The normal suite uses a local HTTP fixture and the real domain Engine, storage, routing tools and outbox. The optional contract test starts a real isolated OpenCode server with a deterministic local model, executes a real shell tool to write a marker in the temporary Ticket directory, and verifies that its structured report completes the Ticket. It needs no provider credentials and does not prove a production account/model configuration is working.
