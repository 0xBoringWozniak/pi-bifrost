# Development

## Requirements

- Use Node.js 24, as CI does. It supports `--experimental-strip-types`.
- Tests use the pinned Pi 1.0.1 dependency.
- Python 3 and Pillow are needed for `npm run test:ui`.
- The project dependencies include `agent-tui` for reliability UI tests.

Install the project dependencies from the repository root:

```bash
npm ci
python3 -m pip install Pillow==12.3.0
```

Use a Python virtual environment if your system Python requires one. Put its executables on `PATH` before running the checks. The committed npm lock file fixes the Node dependency versions.

## Complete verification

Run all release checks with one command:

```bash
npm run verify:release
```

The command checks Pi, Python Pillow, and `agent-tui` before running unit tests, typecheck, the router build, fake-provider integrations, and both UI suites. It records the revision, source hashes, gate results, and log paths under `screenshots/verification/<run>/result.json`. A failed gate, dirty working tree, or revision or source change makes the command fail.

CI runs `npm run acceptance`, which includes the release gates and named acceptance journeys. It uploads the acceptance evidence bundle on each run, plus release logs and UI screenshots after a failure. The deterministic checks use isolated homes and local fake providers. They need no live provider credentials.

Each configured CI acceptance run also writes `ci-report.md` and bounded `report-data.json` beside its `evidence.json`. At the end of the required PR gate, the workflow adds a final report to its Actions summary and uploads it as an artifact. The report shows the exact commit, run and attempt, duration, seven release gates, case counts, required issues, and evidence links. Its confidence label is `BLOCKED`, `INCOMPLETE`, `VERIFIED CHECKS`, or `LIMITED`; it is not a probability or a claim of complete PRD coverage. Missing required gates, required failures or blocks, a cancelled run, source drift, or stale evidence cannot be green. The report separates deferred cases from failures. It states that live providers were not run and that fake-provider results cover only their named cases.

To preview a report from one explicit evidence file, run `node scripts/ci-report.mjs --evidence screenshots/acceptance/<runId>/evidence.json --output-dir /tmp/bifrost-ci-report`. The tool does not select the newest evidence automatically. The separate PR-comment publisher consumes `report-data.json` as untrusted evidence, binds its own GitHub commit and workflow metadata, and recomputes the confidence result. GitHub can run that publisher only after its workflow reaches the default branch; the PR Actions summary and artifact work before that merge.

Use [the coverage contract](docs/testing-coverage.md) when adding a feature or regression test. Pi tests must assert behavior at the host boundary. Consumer API and deterministic race tests use their own public boundaries.

## Checks

Run the unit tests and TypeScript check before you send a change for review:

```bash
npm test
npm run typecheck
```

Run integration tests when a change affects Pi commands, model dispatch, or routing:

```bash
npm run test:integration
```

The integration tests start Pi in isolated workspaces. Several suites use a local fake provider and block external network requests.

Run the terminal UI smoke test for visible Pi changes:

```bash
npm run test:ui
```

This test uses a local fake provider. It needs Python 3 and Pillow. It writes screenshots and logs under `screenshots/ui-smoke/`.

Run the reliability UI scenarios for circuit, reload, Auto, and queued-turn changes:

```bash
npm run test:ui:reliability
```

This test uses a local fake provider and `agent-tui`. It sets `PI_OFFLINE=1` and blocks external network requests.

`npm run test:ui:agent-tui` is a separate proof of concept. It uses the local Ollama model `gemma4:12b-mlx`. It does not replace `npm run test:ui`.

## Build the router package

The router build creates files in `dist/router/`:

```bash
npm run build:router
```

`npm pack` runs this build through the `prepack` script.

## Provider-state performance check

Run this after freezing the candidate:

```bash
node --experimental-strip-types scripts/provider-projection-benchmark.mjs /tmp/provider-projection.json
```

The script executes the projection from pinned commit `b5b38945` and the current implementation. It checks identical selected and excluded state, snapshot read counts, source fingerprints and revision stability. Fixtures cover 10, 100 and 1,000 models, multiple providers, and small and large histories. It measures both injected-memory and real local-file reads. Representative cases use 101 samples and nearest-rank percentiles.

This measures the provider projection and store, not a full Pi turn. Heap and RSS changes are noisy; JSON volume is a separate work estimate. Run the existing routing benchmark for the core resolver. Keep provider latency and generation quality out of these claims.

## Unattended Release Acceptance

Run the offline profile for release checks. It runs `verify:release` (unit, typecheck, router build, pinned-Pi integration, general UI, and reliability UI) and the named critical journeys. Pi processes use isolated test homes, fake providers, and the outbound network guard.

```bash
npm run acceptance                         # deterministic by default
npm run acceptance -- --profile deterministic
npm run acceptance -- --profile contract  # native Pi SDK request-builder contracts
npm run verify:release                     # seven release gates (preflight + six checks) only
```

`npm run acceptance:deterministic` remains as a compatibility alias. Unknown flags fail before a profile starts. A run writes ordered case outcomes and sanitized logs under `screenshots/acceptance/<runId>/`. Evidence records the starting and ending revision, source fingerprint and dirty Git paths, actual installed tool versions (separate from package ranges), duration, attempts, exclusions, and case artifacts. A source change during the run fails the candidate-stability case. Failed or required blocked cases return a nonzero exit code.

The contract profile uses the pinned Pi SDK request builders, synthetic credentials, and controlled local transports. It states whether each case is a direct native-adapter contract or a real Pi RPC interaction; a direct adapter test is not labeled Pi E2E. The Node preload guard fences non-loopback `fetch`, TCP sockets, and all UDP sends, then records violations. It is not an operating-system sandbox for arbitrary external binaries; deterministic shell network commands are limited to known loopback fixtures.

Live acceptance is opt-in and is not part of implementation checks. The supervising agent must name exactly one model from Pi's managed registry. This example needs a real `provider/model` value substituted before use:

```bash
npm run acceptance -- --profile live --allow-live \
  --allow-model provider/model \
  --max-requests-per-model 4 --deadline-seconds 60
```

The runner allows at most four actual HTTP attempts per model, including retries, and a 300-second deadline. Its default budget is four because the complete controlled journey needs four calls; an explicit lower budget is blocked before traffic if it cannot complete that journey. This is a request-count bound, not a token or spend cap. The live profile supports only Pi's native OpenAI, Codex, and Anthropic HTTPS origins. Custom provider origins and local endpoints are blocked before requests. It never scans the authenticated registry. It uses Pi-managed authentication and synthetic prompts, and records neither credentials nor account identifiers. Missing credentials, exhausted quota, or unsupported prerequisites are `BLOCKED`, not `PASS`. Do not run this profile during implementation.

See the [acceptance coverage map](docs/acceptance-coverage.md) for the exact PRD requirement boundaries and known gaps. The tracked map names evidence cases; only an evidence bundle from the candidate under review proves those cases passed.
