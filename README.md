# DB9 Action

Create temporary DB9 databases and branches for GitHub Actions.

This action calls the DB9 API directly, creates a DB9 database, exports a
temporary PostgreSQL connection URL, and deletes the database in the post step by
default. If `db9-api-key` is omitted, the action uses anonymous provisioning.

## Usage

### Ephemeral database per CI run

```yaml
name: test

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: db9-ai/db9-action@v1
        id: db9

      - run: psql "$DATABASE_URL" -c "select 1"
```

The same connection URL is also available as an action output. Pass it through a
step environment variable when using it in a shell command:

```yaml
- run: psql "$DATABASE_URL" -c "select 1"
  env:
    DATABASE_URL: ${{ steps.db9.outputs.database-url }}
```

### Authenticated project database

Anonymous provisioning is the default. To create databases from an existing DB9
account or project, pass an API key:

```yaml
- uses: db9-ai/db9-action@v1
  id: db9
  with:
    db9-api-key: ${{ secrets.DB9_API_KEY }}
    project-id: ${{ vars.DB9_PROJECT_ID }}
```

### Branch per CI run

Use branch mode when tests need a copy of an existing database.

```yaml
- uses: db9-ai/db9-action@v1
  id: db9
  with:
    mode: branch
    db9-api-key: ${{ secrets.DB9_API_KEY }}
    project-id: ${{ vars.DB9_PROJECT_ID }}
    source-database-name: staging
    database-name: ci-${{ github.run_id }}-${{ github.run_attempt }}
```

Branch mode requires `project-id`; the source database must belong to that
project. Use `source-database-id` instead of `source-database-name` when you
already know the DB9 database ID. Branch mode waits for the branch to become
`ACTIVE` before fetching the connection URL.

### Parallel test workers

Create one database per matrix entry or test worker:

Generated names longer than 63 characters include a hash of the full repository,
run, attempt, prefix, and worker identity so truncation does not discard the
differences between jobs. Short generated names keep their existing format.

```yaml
strategy:
  matrix:
    worker: [1, 2, 3, 4]

steps:
  - uses: db9-ai/db9-action@v1
    id: db9
    with:
      database-name-prefix: ci
      worker-id: w${{ matrix.worker }}

  - run: npm test
    env:
      DATABASE_URL: ${{ steps.db9.outputs.database-url }}
```

### Scheduled cleanup fallback

The post step deletes the database created by the current job. If a workflow can
be cancelled before post steps run, add a scheduled fallback cleanup with an API
key:

```yaml
name: DB9 Cleanup

on:
  schedule:
    - cron: "0 */6 * * *"

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: db9-ai/db9-action@v1
        with:
          mode: cleanup
          db9-api-key: ${{ secrets.DB9_API_KEY }}
          project-id: ${{ vars.DB9_PROJECT_ID }}
          cleanup-prefix: ci-
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `mode` | `database` | Operation to run: `database`, `branch`, or `cleanup`. |
| `database-name` | generated | Name for the DB9 database or branch. |
| `database-name-prefix` | `gha` | Prefix used when generating a database name. |
| `worker-id` | unset | Optional worker or matrix identifier appended to generated database names. |
| `region` | DB9 default | DB9 region to create the database in. |
| `project-id` | DB9 default | DB9 project ID. Required for branch and cleanup modes, which only use databases in the specified project. |
| `database-user` | `admin` | Database user to request in the temporary connection URL. |
| `source-database-id` | unset | Source DB9 database ID for `branch` mode. |
| `source-database-name` | unset | Source DB9 database name for `branch` mode. Used only when `source-database-id` is not set. |
| `snapshot-at` | unset | Optional RFC3339 timestamp for point-in-time branch mode. |
| `wait` | `true` | Wait for async database operations to become `ACTIVE`. Branch mode waits by default. |
| `wait-timeout-seconds` | `120` | Maximum seconds to wait for `ACTIVE`. |
| `wait-interval-seconds` | `2` | Seconds between status polls while waiting. |
| `cleanup-prefix` | unset | Database name prefix to delete in `cleanup` mode. Required for cleanup mode. |
| `db9-api-key` | unset | DB9 API key. Omit for anonymous provisioning. |
| `db9-api-url` | `https://api.db9.ai` | DB9 API base URL. |
| `cleanup` | `true` | Delete the created database in the post step. |
| `export-env` | `true` | Export `DATABASE_URL`, `DB9_DATABASE_URL`, and `DB9_DATABASE`. |

## Outputs

| Output | Description |
| --- | --- |
| `database-url` | Temporary PostgreSQL connection URL for the created DB9 database. |
| `database-name` | Name of the created DB9 database. |
| `database-id` | ID of the created DB9 database, when returned by the DB9 API. |
| `database-user` | Database user used for the temporary connection URL. |
| `expires-at` | Expiration timestamp for the temporary connection URL, when returned by the DB9 API. |
| `database-state` | Final state observed for the created DB9 database or branch. |
| `cleanup-count` | Number of databases deleted in `cleanup` mode. |

## Cleanup

Cleanup is enabled by default. The action records the created database and runs:

`DELETE /customer/databases/<database-id>`

in the post step. Set `cleanup: false` only when you intentionally want to keep
the database after the workflow finishes.

Post cleanup requires the signed v2 record saved by the main step. If the record
is missing, uses an older format, or fails verification, deletion is skipped.
The record must contain a non-empty string database ID; cleanup never falls back
to deleting by name. A create or branch response without a valid database ID
fails the main step before polling or connecting by name.

An HMAC signature mismatch emits the fixed `DB9_CLEANUP_INTEGRITY_FAILURE`
error annotation and, when `GITHUB_STEP_SUMMARY` is available, appends a fixed
security event summary without credentials or unverified state. Cleanup makes
no API requests on this path. The annotation and summary do not change the post
step's exit code; a missing or unwritable summary does not fail the step.
These records use GitHub's normal access controls and retention.

`cleanup: false` means db9-action will not delete the database. DB9
documentation does not specify an automatic retention period for anonymous
databases. Anonymous databases count toward the 5-database anonymous account
limit, and the temporary connection URL expires independently.

`mode: cleanup` is separate from the post step cleanup. It requires `project-id`
and deletes only databases in that project whose names start with `cleanup-prefix`.

## Security notes

- The action masks `db9-api-key`, anonymous credentials and account ID, and the
  generated `database-url` in workflow logs. Informational messages suspend runner
  command parsing while displaying API-returned text.
- `db9-api-url` must use `https` and must not contain a query string, including
  an empty `?`. Custom HTTPS hosts and path prefixes remain supported.
  The action does not follow redirects before sending the API credential.
- Project restrictions apply to this action. Anyone with the same API key can
  call the API directly and access the projects permitted by that key.
- API-key mode reads the key again from the action input in the post step instead
  of copying it into GitHub Actions state.
- Anonymous mode stores its temporary API token and refresh secret in GitHub
  Actions state so the post step can delete the database even if the token expires.
  The signed cleanup record contains the account ID but no token or refresh secret.
  State is not a security boundary against untrusted code running on the same runner.
- The exported connection URL is temporary because it uses a DB9 connect token.
  Prefer passing it through GitHub Actions environment variables or outputs
  instead of printing it.
- The connect-token response host must be a single ASCII DNS hostname, IPv4
  address, or bracketed IPv6 address. URI delimiters, control characters, host
  lists, and IPv6 zone identifiers are rejected before exporting the URL.
  Valid hosts are preserved as returned. This syntax check does not enforce
  TLS or verify the identity of the database server.
