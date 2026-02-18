#!/usr/bin/env bash
# Launch the Shopping Center Gap Analysis web app.
# Usage: ./run.sh [port]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/.venv"
PORT="${1:-8501}"

if [ ! -d "$VENV" ]; then
    echo "Virtual environment not found. Setting it up..."
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --upgrade pip setuptools wheel -q
    "$VENV/bin/pip" install -r "$SCRIPT_DIR/requirements.txt" -q
    echo "Setup complete."
fi

echo "Starting Shopping Center Gap Analysis on http://localhost:$PORT"
"$VENV/bin/streamlit" run "$SCRIPT_DIR/app.py" \
    --server.port "$PORT" \
    --server.headless true \
    --server.address 0.0.0.0
