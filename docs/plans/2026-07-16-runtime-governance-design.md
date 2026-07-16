# SOTAgent runtime governance design

## Scope

SOTAgent has two persistent listeners:

| Service ID | Role | Preferred port | Current PID | Auto-start |
|---|---|---:|---:|---:|
| `sotagent` | Hono compatibility API | 4800 | 3462 | true |
| `sotagent-console` | Vite preview console | 4880 | 17137 | true |

Both services must use PolarPort as their port authority and PolarProcess as
their lifecycle authority. SOTAgent's `/api/ports` and `/api/services` routes
remain compatibility/observation facades, not authorities for new code.

## Launchers

- `Start/api.sh` checks PolarPort, claims `sotagent/SOTAgent:4800`, exports the
  allocated port, resolves Node 22, and foreground-execs `src/web.ts`.
- `Start/console.sh` applies the same contract to
  `sotagent-console/SOTAgent:4880` and foreground-execs Vite preview.
- `Start/start.sh`, `stop.sh`, `restart.sh`, and `status.sh` are compatibility
  lifecycle clients that delegate the exact `sotagent` action to PolarProcess.
- The legacy root `start.sh` becomes the same thin lifecycle client and no
  longer backgrounds two processes or sends signals.

The API reads its binding from `SOTAGENT_API_PORT`/`PORT` before the static
configuration. The console proxy reads `SOTAGENT_API_PORT`; governed launchers
therefore consume PolarPort decisions rather than inventing a second registry.

## Existing-process boundary

The live API is also a loaded `com.sotagent.web` launchd KeepAlive job. The
current PolarPort records for 4800 and 4880 are released or owned by a retired
identity, and PolarPort correctly refuses to activate an already-bound port.
Consequently, code and PolarProcess registration can be prepared without
disturbing either PID, but final PolarPort activation and launchd retirement
require a dedicated handoff that changes the live API process. This migration
must remain non-done until that handoff is explicitly verified.

## Verified handoff outcome

The dedicated handoff completed on 2026-07-16. The API now runs under
PolarProcess with verified listener PID 78575 and PolarPort owner
`sotagent/SOTAgent:4800`; the legacy launchd job is unloaded, disabled, and its
plist removed. The Console was restarted only through its exact PolarProcess
endpoint and now runs as PID 87073 with owner
`sotagent-console/SOTAgent:4880`.
