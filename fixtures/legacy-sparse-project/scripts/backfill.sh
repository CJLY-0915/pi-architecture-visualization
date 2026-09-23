#!/bin/sh
# Ad-hoc backfill. Chained onto the nightly run by whoever is on call; not
# referenced by config/jobs.yml and not owned by anyone.
set -e
python3 scripts/reconcile.py --date "$1"
echo "backfill for $1 done"
