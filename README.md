# GO-CAM Mega Editor

A modern, full-stack visual pathway editor for GO-CAM (Gene Ontology Causal Activity Models). Unlike the legacy Noctua Visual Pathway Editor which works on one model at a time, this editor is designed for **interconnected mega-models** — visualizing and editing networks of GO-CAM models at the biological process level.

Think of it like Google Maps for biology: zoom out to see the full network of pathways, zoom in to edit individual activity nodes and causal connections.

## Screenshots

### Model Browser
Searchable list of GO-CAM models with group badges, dates, and contributor info. Filter by title, ID, group, or contributor name.

![Model list](docs/screenshots/01-model-list.png)

![Search filtering](docs/screenshots/02-search.png)

### Graph Visualization
Activity graph with nodes color-coded by biological process and edges styled by regulation type. Legend shows process colors and edge types. MiniMap provides overview navigation.

![Graph view — C. elegans MAPK cascade](docs/screenshots/03-graph-view.png)

### Semantic Zoom
Click any node to expand it inline and open the detail panel showing gene product, molecular function, biological process, cellular component, and full evidence with ECO codes and PMIDs.

![Detail panel](docs/screenshots/04-detail-panel.png)

### Editing
Toggle edit mode to modify activities. Edit gene product, molecular function, biological process, cellular component, and evidence. Drag between node handles to create new causal edges with a predicate picker.

![Edit panel](docs/screenshots/05-edit-panel.png)

### Change History and Neighbor Import
The editor keeps a structured local change history with undo/redo, and model pages expose neighboring-model import directly from the header so related pathways can be brought into the same workspace. The `Neighbors` browser is scoped to the currently focused model, can be filtered by model title/ID/shared gene, and shared-gene badges can jump directly to the matching activity in the graph.

### Multiple Pathway Types
Works with different pathway topologies — from branching signaling cascades to linear metabolic pathways.

![Canonical glycolysis](docs/screenshots/06-glycolysis.png)

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Frontend (React + TypeScript)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐│
│  │ Model    │ │ Graph    │ │ Activity Detail  ││
│  │ List     │ │ View     │ │ / Edit Panel     ││
│  │          │ │(ReactFlow)│ │                  ││
│  └──────────┘ └──────────┘ └──────────────────┘│
│  Vite · shadcn/ui · TanStack Query · Tailwind  │
└──────────────────┬──────────────────────────────┘
                   │ /api proxy
┌──────────────────▼──────────────────────────────┐
│  Backend (Python + FastAPI)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐│
│  │ /models  │ │/model/{id}│ │ /graph           ││
│  │ (index)  │ │ (CRUD)   │ │ (mega-graph)     ││
│  └──────────┘ └──────────┘ └──────────────────┘│
│  GoCamService · MinervaWrapper · NetworkX       │
└──────────────────┬──────────────────────────────┘
                   │ REST
┌──────────────────▼──────────────────────────────┐
│  Gene Ontology API                              │
│  gocam package · Minerva · GO S3 index          │
└─────────────────────────────────────────────────┘
```

### Backend

- **FastAPI** app wrapping the [`gocam`](https://github.com/geneontology/gocam) Python package
- **`/models`** — paginated model index from the GO public S3 bucket
- **`/model/{id}`** — full GO-CAM model fetched from the Minerva API, serialized as JSON with predicate label enrichment
- **`PATCH /model/{id}/activity/{activity_id}`** — update gene product, molecular function, biological process, cellular component, evidence
- **`POST /model/{id}/causal-edge`** — create causal associations between activities
- **`DELETE /model/{id}/causal-edge`** — remove causal associations
- **`/graph?model_id=X&model_id=Y`** — interconnected gene-to-gene mega-graph via the gocam NetworkX translator
- In-memory model caching for fast repeated access

### Frontend

- **React 19** + TypeScript + Vite
- **React Flow** for interactive graph visualization with custom activity nodes
- **shadcn/ui** component library on Tailwind CSS v4
- **TanStack Query** for data fetching and caching

### Key Features

- **Color-coded biological processes** — each node is colored by its biological process annotation, with a legend overlay
- **Edge styling by regulation type** — green for positive regulation, red for negative, gray for other causal relations
- **Semantic zoom** — click any node to:
  - Expand it inline (gene product, molecular function, biological process, cellular component)
  - Open a detail panel with full evidence (ECO codes, PMIDs, with_objects)
- **Editing** — toggle edit mode to:
  - Modify gene product, molecular function, biological process, cellular component
  - Add/remove evidence with ECO codes and PMID references
  - Drag between nodes to create causal edges with predicate picker
- **Structured change history** — local persistent change log with `Undo`, `Redo`, change history, and per-change revert
- **Neighboring model browser** — import connected models into the same level-2 workspace from the header-level `Neighbors` browser or from node/detail-panel discovery paths, and jump from shared-gene badges to connector activities in the focused model
- **Searchable model list** — filter by title, ID, contributor, or group
- **MiniMap** with process-colored nodes for overview navigation

## Quick Start

### Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Node.js 18+
- [just](https://github.com/casey/just) (optional, for convenience commands)

### Run Both Servers

```bash
# Start both servers
just dev
```

Or manually:

```bash
# Terminal 1: Backend (port 8484)
uv sync
uv run gocam-mega-editor serve --no-reload

# Terminal 2: Frontend (port 5173, proxies /api to backend)
cd frontend
npm install
npm run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:5173

Backend notes:
- the backend listens on `127.0.0.1:8484`
- the default adapter is `auto`, which prefers the local `data/models` corpus
- local edits persist under `.gocam-state/`

### Run Tests

```bash
uv run pytest
cd frontend && npm run lint
cd frontend && npm run test
cd frontend && npm run build
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/models` | GET | List models (query: `limit`, `offset`) |
| `/model/{id}` | GET | Full model as JSON |
| `/model/{id}/connections` | GET | Shared-gene neighboring models for one model |
| `/model/{id}/changes` | GET | Structured change history for one model |
| `/model/{id}/activity/{activity_id}` | PATCH | Update activity associations and evidence |
| `/model/{id}/causal-edge` | POST | Create causal association between activities |
| `/model/{id}/causal-edge` | DELETE | Remove causal association (query: `source_activity_id`, `target_activity_id`) |
| `/model/{id}/changes/undo` | POST | Undo the latest applied model change |
| `/model/{id}/changes/redo` | POST | Redo the latest undone model change |
| `/model/{id}/changes/{change_id}/revert` | POST | Revert a specific applied model change |
| `/graph` | GET | Mega-graph (query: `model_id`, repeatable) |
| `/predicates` | GET | List available causal predicates with labels |
| `/health` | GET | Health check |

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
├── docs/screenshots/                  # Auto-generated screenshots
├── pyproject.toml
├── justfile
└── README.md
```

## Data Source

In local development, the backend now defaults to the checked-in `data/models` corpus with a local overlay for edits in `.gocam-state/`. It can still fall back to live GO/Minerva-backed reads when configured to do so.

The backend uses the [`gocam`](https://github.com/geneontology/gocam) package which provides:

- LinkML-based Pydantic data models
- Minerva API wrapper for fetching models
- NetworkX graph translator for gene-to-gene networks
