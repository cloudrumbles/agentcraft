# Linux and CLIProxyAPI verification

Base: upstream `0be815deb4833a9ce0f070c29737bba882e98759` (MIT license retained).
Verified on Linux x86_64 with Node 24.19.0 on 2026-10-03.

## Checks

- `npm run check --prefix foreman`: **537 tests / 26 files passed**, TypeScript passed, and generated protocol documentation was current. The proxy orchestration regression passed five additional consecutive runs.
- `npm test --prefix tools`: **18 tests passed**, covering launcher, process ownership, JDK discovery and existing tools.
- Real installed Claude Agent SDK against localhost mock gateway: exact `claude-opus-5-5` and
  `gpt-6.1-sol` model IDs, streaming in-process MCP calls and tool results, persisted session
  resume, and cancellation. These tests use fake responses and isolated temporary credentials;
  they do not establish provider quality, availability, quota or paid billing behavior.
- Foreman integration: Wren/Kit model routing, worktrees, policy callbacks, no fallback model,
  git safeguards, model-change session protection and credential redaction.
- Model-list preflight: missing-model failures, malformed responses, authentication failures,
  redirect refusal, environment/config/CLI precedence and all six model assignments.
- Production `tools/linux.mjs` headless simulation launch, WebSocket status read and owned-process
  shutdown passed. No real model goal or graphical client was started.
- Java 25 compilation of the changed `Protocol` and `ForemanJson` classes, with Gson 2.13.1 and
  JSpecify 1.0.0, plus JSON round trips for all backend values, unknown fallback and a legacy
  agent-state value passed. Temporary Temurin 25.0.4.1 was checksum-verified against its official
  release. This targeted check is not a full Minecraft mod build.
- `git diff --check` and a source scan for private-key/GitHub-token/Anthropic-token patterns passed.
  Test credentials are deliberate local fixtures. No credentials, dependency directories,
  build caches, local logs or simulation state are included in the commit.

## Remaining checks

The full `mod/gradlew build` was attempted with Java 25, but the environment could not download
Gradle 9.7.1 (`Network is unreachable`). Full mod compilation, Minecraft rendering, Linux graphics,
and real provider calls are therefore **not verified**. Run the build in a Linux environment with
Java 25 and network access, then try `--backend sim` before a real goal. The repository has no
GitHub Actions workflow; a published branch alone is not CI verification.

CLIProxyAPI must expose the configured IDs and route GPT-6.1 tool calls through a Responses-capable
upstream. The SDK can warn that GPT is an unrecognized model while still forwarding it correctly.
Proxy cost estimates are not guaranteed accurate. Model-list preflight blocks redirects; actual
Messages redirect handling belongs to the bundled SDK. Choose a gateway you trust with the repo.
