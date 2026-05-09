#!/bin/bash
# Test model view flow end-to-end
# Usage: ./test-model-view.sh [directory]
set -e

DIR="${1:-$(pwd)}"
BACKEND="${OPENCODE_BACKEND:-http://localhost:4097}"
LOG_FILE="${OPENCODE_LOG:-$HOME/.local/share/opencode/log/dev.log}"
SESSION_ID=""

echo "=== Backend: $BACKEND ==="
echo "=== Directory: $DIR ==="
echo "=== Log: $LOG_FILE ==="

# Check backend is alive
if ! curl -sf -o /dev/null "$BACKEND/project"; then
  echo "ERROR: Backend not reachable at $BACKEND"
  exit 1
fi
echo "Backend OK"

# Get or create a session
echo ""
echo "--- Sessions ---"
SESSIONS=$(curl -sf "$BACKEND/session?directory=$DIR&limit=1")
SESSION_ID=$(echo "$SESSIONS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
  echo "No session found, creating..."
  SESSION_ID=$(curl -sf -X POST "$BACKEND/session?directory=$DIR" \
    -H "Content-Type: application/json" \
    -d '{}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
  echo "Created session: $SESSION_ID"
else
  echo "Using session: $SESSION_ID"
fi

# Check log before
BEFORE_LINE=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)

# Send a simple prompt
echo ""
echo "--- Sending prompt ---"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BACKEND/session/$SESSION_ID/prompt_async?directory=$DIR" \
  -H "Content-Type: application/json" \
  -d '{"parts":[{"type":"text","text":"Reply with just the word: OK"}]}')
echo "HTTP $HTTP_CODE"

if [ "$HTTP_CODE" != "204" ]; then
  echo "ERROR: prompt_async returned $HTTP_CODE"
  exit 1
fi

# Wait for processing
echo ""
echo "--- Waiting for ModelRawIO (max 30s) ---"
for i in $(seq 1 30); do
  sleep 1
  AFTER_LINE=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$AFTER_LINE" -gt "$BEFORE_LINE" ]; then
    NEW_LOGS=$(tail -n $((AFTER_LINE - BEFORE_LINE)) "$LOG_FILE")
    if echo "$NEW_LOGS" | grep -q "\[DEBUG\] ModelRawIO published"; then
      echo "✓ ModelRawIO published!"
      echo "$NEW_LOGS" | grep "DEBUG" || true
      exit 0
    fi
    if echo "$NEW_LOGS" | grep -q "prompt_async failed"; then
      echo "✗ prompt_async failed"
      echo "$NEW_LOGS" | grep "ERROR\|prompt_async" || true
      exit 1
    fi
  fi
  printf "."
done
echo ""
echo "✗ Timeout - no ModelRawIO event detected"
echo "Latest log entries:"
tail -20 "$LOG_FILE" | grep -v "permission=bash" || true
exit 1
