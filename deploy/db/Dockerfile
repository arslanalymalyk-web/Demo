# PostgreSQL 16 with PostGIS, plus the openssl tool the backup scripts use. The pgvector extension is optional and is not required yet.
FROM postgis/postgis:16-3.4
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
