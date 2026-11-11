# PostgreSQL 16 with PostGIS, plus the openssl tool the backup scripts use. The pgvector extension is optional and is not required yet.
FROM postgis/postgis:16-3.4@sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
