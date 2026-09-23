#!/usr/bin/env python3
# One-off reconciliation. Pulls the upstream export and diffs it against the
# local store, then writes a report operations reads by hand. The store it
# talks to is not named anywhere in this file.
import sys
import requests

UPSTREAM = "http://10.0.0.7:8080"


def main(date):
    upstream = requests.get(f"{UPSTREAM}/export/{date}").json()
    print(f"fetched {len(upstream)} rows for {date}; diff against store pending")


if __name__ == "__main__":
    main(sys.argv[1])
