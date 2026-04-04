# GO-CAM Mega Editor

A modern, full-stack visual pathway editor for GO-CAM (Gene Ontology Causal Activity Models). Unlike the legacy Noctua Visual Pathway Editor which works on one model at a time, this editor is designed for **interconnected mega-models** — visualizing and editing networks of GO-CAM models at the biological process level.

Think of it like Google Maps for biology: zoom out to see the full network of pathways, zoom in to edit individual activity nodes and causal connections.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Frontend (React + TypeScript)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐│
│  │ Model    │ │ Graph    │ │ Activity Detail  ││
│  │ List     │ │ View     │ │ Panel            ││
│  │          │ │(ReactFlow)│ │                  ││
│  └──────────┘ └──────────┘ └──────────────────┘│
│  Vite · shadcn/ui · TanStack Query · Tailwind  │
└──────────────────┬──────────────────────────────┘
                   │ /api proxy
┌──────────────────▼──────────────────────────────┐
│  Backend (Python + FastAPI)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐│
│  │ /models  │ │/model/{id}│ │ /graph           ││
│  │ (index)  │ │ (detail) │ │ (mega-graph)     ││
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
# Install and start everything
just dev
```

Or manually:

```bash
# Terminal 1: Backend (port 8000)
uv sync
uv run gocam-mega-editor serve

# Terminal 2: Frontend (port 5173, proxies /api to backend)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

### Run Tests

```bash
just test          # backend pytest
cd frontend && npx tsc --noEmit  # frontend type check
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/models` | GET | List models (query: `limit`, `offset`) |
| `/model/{id}` | GET | Full model as JSON |
| `/graph` | GET | Mega-graph (query: `model_id`, repeatable) |
| `/health` | GET | Health check |

## Project Structure

```
gocam-mega-editor/
├── src/gocam_mega_editor/
│   ├── app.py          # FastAPI routes
│   ├── service.py      # GoCamService (wraps gocam package)
│   ├── models.py       # Pydantic response models
│   └── cli.py          # CLI (typer)
├── tests/
│   ├── conftest.py     # Fixtures
│   └── test_api.py     # API tests
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── ModelList.tsx         # Searchable model browser
│       │   ├── GraphView.tsx         # React Flow graph + layout
│       │   ├── ActivityNode.tsx      # Custom node with process colors
│       │   ├── ActivityDetailPanel.tsx # Evidence detail sidebar
│       │   └── ProcessLegend.tsx     # Color legend overlay
│       └── lib/
│           ├── api.ts               # API client + types
│           └── colors.ts            # Process color palette + edge classification
├── pyproject.toml
├── justfile
└── README.md
```

## Data Source

Models are fetched live from the [Gene Ontology API](https://api.geneontology.org). The backend uses the [`gocam`](https://github.com/geneontology/gocam) package which provides:

- LinkML-based Pydantic data models
- Minerva API wrapper for fetching models
- NetworkX graph translator for gene-to-gene networks
