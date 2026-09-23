#!/bin/sh
# Nightly reconciliation trigger. Run by hand from an ops box; no scheduler
# definition for it lives in this repo.
set -e
curl -s http://10.0.0.7:8080/internal/nightly >> /var/log/nightly.log 2>&1
python3 scripts/reconcile.py --date "$(date +%F -d yesterday)"
