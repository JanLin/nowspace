#!/bin/bash
cd "$(dirname "$0")"

# Start backend
python3 -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

# Start frontend
source ~/.nvm/nvm.sh
cd frontend && npm run dev -- --port 5173 &
FRONTEND_PID=$!

echo "Backend PID: $BACKEND_PID (port 8000)"
echo "Frontend PID: $FRONTEND_PID (port 5173)"
echo "Press Ctrl+C to stop both"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
