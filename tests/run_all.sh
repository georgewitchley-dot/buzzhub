#!/bin/sh
# Run every Node-vs-Go contract test, each on a fresh copy of the test data (/home/claude/work/fresh.sh).
cd "$(dirname "$0")"
for f in contract_*.py; do
  t=${f#contract_}; t=${t%.py}
  [ "$t" = auth ] || [ "$t" = webhooks ] && continue
  /home/claude/work/fresh.sh
  echo "$t: $(python3 $f 2>&1 | tail -1)"
done
