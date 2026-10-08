#!/bin/sh
set -eu
# Only fresh storage is initialized. A partial first initialization fails closed;
# inspect existing databases and finish the documented schema steps manually.
if [ ! -f /state/initialized ]; then
  for database in temporal temporal_visibility; do
    temporal-sql-tool --plugin postgres12 --ep postgresql -u "$POSTGRES_USER" -p 5432 --db "$database" create
    temporal-sql-tool --plugin postgres12 --ep postgresql -u "$POSTGRES_USER" -p 5432 --db "$database" setup-schema -v 0.0
  done
fi
temporal-sql-tool --plugin postgres12 --ep postgresql -u "$POSTGRES_USER" -p 5432 --db temporal update-schema -d /etc/temporal/schema/postgresql/v12/temporal/versioned
temporal-sql-tool --plugin postgres12 --ep postgresql -u "$POSTGRES_USER" -p 5432 --db temporal_visibility update-schema -d /etc/temporal/schema/postgresql/v12/visibility/versioned
touch /state/initialized
