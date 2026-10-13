#!/usr/bin/env bash
# تشغيل بوابة Node الذكية (بدون أي تثبيت — Node 22+ فقط)
set -e
cd "$(dirname "$0")/../node"
node src/server.js
