# GO-CAM Mega Editor

# Start the backend API server
serve-backend:
    uv run gocam-mega-editor serve --no-reload

# Start the frontend dev server (proxies /api to backend)
serve-frontend limit="200":
    cd frontend && VITE_MODEL_LIST_LIMIT={{limit}} npm run dev -- --host 127.0.0.1

# Kill processes listening on the standard dev ports
kill-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    for port in 8484 5173; do
      pids="$(lsof -tiTCP:$port -sTCP:LISTEN || true)"
      if [[ -n "$pids" ]]; then
        echo "Killing port $port: $pids"
        kill $pids 2>/dev/null || true
      fi
    done

# Start both backend and frontend, replacing anything already on the dev ports
dev limit="300": kill-dev
    #!/usr/bin/env bash
    set -euo pipefail
    uv run gocam-mega-editor serve --no-reload &
    BACKEND_PID=$!
    cd frontend && VITE_MODEL_LIST_LIMIT={{limit}} npm run dev -- --host 127.0.0.1 &
    FRONTEND_PID=$!
    trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
    wait

# Fetch GO-CAM models into the local development corpus
cache-models limit="200":
    uv run gocam-mega-editor cache-models data/models --limit {{limit}}

# Fetch models, then restart both dev servers with a matching frontend list limit
cache-dev limit="300":
    just cache-models {{limit}}
    just dev {{limit}}

# Serve documentation site
docs:
    uv run mkdocs serve -a 127.0.0.1:8485

# Run backend tests
test:
    uv run pytest tests/ -v

# Run tests with coverage
test-cov:
    uv run pytest tests/ -v --cov=gocam_mega_editor

# Build frontend for production
build-frontend:
    cd frontend && npm run build

# Lint
lint:
    uv run ruff check src/ tests/
    uv run ruff format --check src/ tests/

# Format
fmt:
    uv run ruff format src/ tests/
    uv run ruff check --fix src/ tests/
