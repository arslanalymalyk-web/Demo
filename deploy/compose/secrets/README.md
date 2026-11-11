# Secrets
Create these files here, each holding one value, mode 600, never committed (`.gitignore` excludes this directory's contents).
Generate random values with `openssl rand -base64 36 | tr -d '\n'`. Prefer the client's own secret store and mount from it.

| File | Content |
|---|---|
| postgres_password | superuser password for the database container (used only for set-up and backups) |
| db_owner_password, db_app_password | passwords of the two database roles, at least 16 characters |
| db_owner_url | `postgres://tigeris_owner:<owner password>@db:5432/tigeris` (migrations only) |
| db_app_url | `postgres://tigeris_app:<app password>@db:5432/tigeris` (the API; refuses to start with any other role) |
| metrics_token | at least 24 characters; the bearer token for `/metrics` on the internal network |
| backup_key | passphrase of at least 32 characters; keep a copy in the client's safe. Without it no backup can be read. |

Rotation: change the file, then `docker compose up -d --force-recreate <service>`. Database passwords also need `ALTER ROLE ... PASSWORD` first.
| document_key | optional (docker-compose.keys.yml): at least 32 characters; seals uploaded documents. Keep a copy somewhere the database backup is not. Without it sealed documents cannot be read. |
| audit_anchor_key | optional (docker-compose.keys.yml): at least 32 characters; signs audit checkpoints. Keep it away from the database administrator. |
