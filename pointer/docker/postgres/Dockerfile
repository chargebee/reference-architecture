# Postgres 18 with pg_cron, which creates the weekly `usage_event` partitions.
#
# Debian rather than the alpine variant: PGDG ships `postgresql-18-cron` as a
# package, while alpine has no build of it in the official image's tree and
# needs the shared object and control files relocated into
# /usr/local/{lib,share}/postgresql by hand.
#
# `shared_preload_libraries` and `cron.database_name` are passed as server flags
# from docker-compose, mirroring the RDS parameter group in infra/rds.tf.
FROM postgres:18

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-18-cron \
    && rm -rf /var/lib/apt/lists/*
