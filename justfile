# GO-CAM Mega Editor

# Start the backend API server
serve-backend:
    uv run gocam-mega-editor serve

# Start the frontend dev server (proxies /api to backend)
serve-frontend:
    cd frontend && npm run dev

# Start both backend and frontend
dev:
    #!/usr/bin/env bash
    uv run gocam-mega-editor serve &
    BACKEND_PID=$!
    cd frontend && npm run dev &
    FRONTEND_PID=$!
    trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
    wait

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
