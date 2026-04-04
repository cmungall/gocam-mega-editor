# Getting Started

## Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Node.js 18+
- [just](https://github.com/casey/just) (optional, for convenience commands)

## Installation

```bash
git clone https://github.com/cmungall/gocam-mega-editor
cd gocam-mega-editor
```

## Running

### With just (recommended)

```bash
just dev
```

This starts both the backend (port 8000) and frontend (port 5173).

### Manually

=== "Terminal 1 — Backend"

    ```bash
    uv sync
    uv run gocam-mega-editor serve
    ```

=== "Terminal 2 — Frontend"

    ```bash
    cd frontend
    npm install
    npm run dev
    ```

Open [http://localhost:5173](http://localhost:5173).

## Running Tests

```bash
just test                          # 15 backend pytest tests
cd frontend && npx tsc --noEmit   # frontend type check
```

## Project Structure

```
gocam-mega-editor/
├── src/gocam_mega_editor/
│   ├── app.py          # FastAPI routes
│   ├── service.py      # GoCamService (wraps gocam package)
│   ├── models.py       # Pydantic request/response models
│   └── cli.py          # CLI (typer)
├── tests/
│   ├── conftest.py     # Fixtures
│   └── test_api.py     # API tests (15 tests)
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── ModelList.tsx          # Searchable model browser
│       │   ├── GraphView.tsx          # React Flow graph + layout + edit mode
│       │   ├── ActivityNode.tsx       # Custom node with process colors
│       │   ├── ActivityDetailPanel.tsx # Read-only evidence detail sidebar
│       │   ├── ActivityEditPanel.tsx   # Editable form for activity CRUD
│       │   ├── NewEdgeDialog.tsx       # Predicate picker for new causal edges
│       │   └── ProcessLegend.tsx      # Color legend overlay
│       └── lib/
│           ├── api.ts                 # API client, types, mutations
│           └── colors.ts             # Process color palette + edge classification
├── docs/                              # Documentation (this site)
├── pyproject.toml
├── justfile
└── README.md
```
