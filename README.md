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

The same connection URL is also available as an action output:

```yaml
- run: psql "${{ steps.db9.outputs.database-url }}" -c "select 1"
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
    source-database-name: staging
    database-name: ci-${{ github.run_id }}-${{ github.run_attempt }}
```

Use `source-database-id` instead of `source-database-name` when you already know
the DB9 database ID. Branch mode waits for the branch to become `ACTIVE` before
fetching the connection URL.

### Parallel test workers

Create one database per matrix entry or test worker:

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
| `project-id` | DB9 default | DB9 project ID to create the database in. |
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

`cleanup: false` means db9-action will not delete the database. DB9
documentation does not specify an automatic retention period for anonymous
databases. Anonymous databases count toward the 5-database anonymous account
limit, and the temporary connection URL expires independently.

`mode: cleanup` is separate from the post step cleanup. It lists databases in
the authenticated account and deletes only names that start with `cleanup-prefix`.

## Security notes

- The action masks `db9-api-key` and the generated `database-url` in workflow logs.
- Anonymous mode stores its temporary API token only in GitHub Actions state so
  the post step can delete the database.
- The exported connection URL is temporary because it uses a DB9 connect token.
  Prefer passing it through GitHub Actions environment variables or outputs
  instead of printing it.
