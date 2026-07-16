# SOTAgent runtime governance implementation plan

1. Record R6 as `in-progress` and declare the API and console services.
2. Add a failing runtime contract for foreground launchers, PolarProcess-only
   lifecycle clients, environment-driven bindings, and registration metadata.
3. Implement the launchers, compatibility clients, registration script, API
   environment binding, and console proxy binding.
4. Run shell/contract tests, TypeScript build, console build, project tests, and
   the governance audit; preserve all pre-existing failures as baseline data.
5. Merge without restarting either live service and register both existing IDs
   in place only when the operation cannot change their PIDs.
6. If PolarPort cannot activate the occupied preferred ports, record R6 as
   blocked with exact evidence; do not bypass PolarPort or unload launchd.

