# PostgreSQL 16 with PostGIS, plus the openssl tool the backup scripts use. The pgvector extension is optional and is not required yet.
FROM postgis/postgis:18-3.6@sha256:4a43e3c3e5d55b9208240fc71db543b79c638766280c625a425bd0a2390989c4
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
