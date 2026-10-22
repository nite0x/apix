# Production frontend verification

These tests exercise the built React UI as served by the Go runtime. They do not
launch a development server, replace an existing runtime, or start configured
external programs. Browser actions use the actual REST APIs and persisted data.

1. Install Chromium with `pnpm exec playwright install chromium`.
2. Build the frontend and runtime, then start that runtime with `APIX_DB_PATH`
   pointing to a new temporary directory and `APIX_ADDR` set to an unused loopback
   port. Keep the temporary credentials key with that database.
3. Run the tests against its address:

   ```sh
   APIX_E2E_URL=http://127.0.0.1:14317 APIX_E2E_ISOLATED=1 pnpm test:e2e
   ```

`APIX_E2E_ISOLATED=1` explicitly confirms that the selected runtime uses an
isolated database. Without it, only the read-only navigation and screenshot tests
run. The mutation tests create uniquely named fixtures and archive only their own
configurations during cleanup. The temporary database retains test runs until the
caller removes that temporary directory after stopping its runtime.

The HTTP and flow execution tests call only that runtime's own `/health`
endpoint. The service test saves an inert executable name and verifies that no
start request is sent. SQL validation uses a saved loopback configuration and
malformed parameters rejected before database access; its missing-connection API
test never reaches a database server.

Set `APIX_E2E_WORK_DIR` if the runtime needs a different existing directory for
the service fixture. Standard Playwright browser environment variables are
supported; `APIX_CHROMIUM_PATH` optionally selects an existing executable.

Screenshots for home, services and requests at 1440×960 and 390×844, together with
failure traces and the HTML report, are written under `test-results/`.
