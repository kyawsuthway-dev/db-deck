#!/bin/bash
# The SQL Server image has no init-script folder: start the server, wait for it, load the seed once
# (when the `sample` database doesn't exist yet), then keep the server in the foreground.
set -u
SQLCMD=(/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD")

/opt/mssql/bin/sqlservr &
server=$!

for _ in $(seq 1 90); do
  "${SQLCMD[@]}" -Q "SELECT 1" >/dev/null 2>&1 && break
  sleep 2
done

if ! "${SQLCMD[@]}" -h -1 -Q "SET NOCOUNT ON; SELECT DB_ID('sample')" | grep -q '[0-9]'; then
  echo "Seeding the sample database"
  if "${SQLCMD[@]}" -b -i /seed/sqlserver.sql; then echo "Seed finished"; else echo "Seed failed"; fi
fi

wait "$server"
