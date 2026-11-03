#!/usr/bin/env bash
# Starts Midterm Live in the background when the Codespace boots (once; safe to run again).
cd "$(dirname "$0")/.."
mkdir -p data/runtime
if curl -fs http://localhost:8080/healthz >/dev/null 2>&1; then
  echo "Midterm Live is already running on port 8080."
  exit 0
fi
nohup setsid npm start > data/runtime/server.log 2>&1 < /dev/null &
for i in $(seq 1 30); do
  if curl -fs http://localhost:8080/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "Midterm Live started on port 8080. Log: data/runtime/server.log"
grep -m1 "Admin token" data/runtime/server.log || true
