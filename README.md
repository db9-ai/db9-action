# DB9 Action

Create temporary DB9 databases for GitHub Actions.

This action installs the DB9 CLI, creates a DB9 database, exports a temporary
PostgreSQL connection URL, and deletes the database in the post step by default.
If `db9-api-key` is omitted, the DB9 CLI uses anonymous provisioning.

## Usage

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

## Authenticated usage

Anonymous provisioning is the default. To create databases from an existing DB9
account or project, pass an API key:

```yaml
- uses: db9-ai/db9-action@v1
  id: db9
  with:
    db9-api-key: ${{ secrets.DB9_API_KEY }}
    project-id: ${{ vars.DB9_PROJECT_ID }}
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `database-name` | generated | Name for the DB9 database. |
| `region` | DB9 default | DB9 region to create the database in. |
| `project-id` | DB9 default | DB9 project ID to create the database in. |
| `database-user` | `admin` | Database user to request in the temporary connection URL. |
| `db9-api-key` | unset | DB9 API key. Omit for anonymous provisioning. |
| `db9-api-url` | DB9 CLI default | DB9 API base URL. |
| `install-cli` | `true` | Install the DB9 CLI before creating the database. |
| `install-url` | `https://db9.ai/install` | DB9 CLI installer URL. |
| `cleanup` | `true` | Delete the created database in the post step. |
| `export-env` | `true` | Export `DATABASE_URL`, `DB9_DATABASE_URL`, and `DB9_DATABASE`. |
| `isolate-credentials` | `true` | Use an isolated `HOME` directory for DB9 CLI credentials. |

## Outputs

| Output | Description |
| --- | --- |
| `database-url` | Temporary PostgreSQL connection URL for the created DB9 database. |
| `database-name` | Name of the created DB9 database. |
| `database-id` | ID of the created DB9 database, when returned by the DB9 CLI. |
| `database-user` | Database user used for the temporary connection URL. |

## Cleanup

Cleanup is enabled by default. The action records the created database and runs:

```sh
db9 delete <database> --yes
```

in the post step. Set `cleanup: false` only when you intentionally want to keep
the database after the workflow finishes.

## Security notes

- The action masks `db9-api-key` and the generated `database-url` in workflow logs.
- Anonymous mode uses an isolated temporary `HOME` by default so credentials do
  not leak into other workflow steps.
- The exported connection URL is temporary. Prefer passing it through GitHub
  Actions environment variables or outputs instead of printing it.
