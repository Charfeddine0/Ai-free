#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
python3 -m pip install -r requirements.txt
python3 -m uvicorn app.main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8080}"
