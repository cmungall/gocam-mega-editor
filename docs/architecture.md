# Architecture

## System Overview

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

## Backend

### GoCamService

The central service layer (`service.py`) wraps the [`gocam`](https://github.com/geneontology/gocam) Python package:

- **MinervaWrapper** — fetches models from the Gene Ontology Minerva API
- **ModelNetworkTranslator** — converts models to gene-to-gene NetworkX DiGraphs
- **In-memory cache** — `dict[str, Model]` storing fetched models for fast re-access and mutation

### Data Model

The backend uses the gocam package's LinkML-generated Pydantic models:

- **Model** — a complete GO-CAM causal pathway model
- **Activity** — a molecular function performed by a gene product
- **Association** — typed link between an activity and an ontology term (MF, BP, CC)
- **CausalAssociation** — causal link between two activities with an RO predicate
- **EvidenceItem** — ECO code + PMID reference supporting an assertion

### CRUD Operations

Write operations mutate the in-memory Pydantic models directly. The `validate_assignment = True` config on the base model ensures type safety on mutation.

## Frontend

### Component Architecture

```
App
├── ModelList              # / route
│   └── ModelCard          # Individual model cards
└── GraphView              # /model/:id route
    ├── ReactFlow          # Graph canvas
    │   ├── ActivityNode   # Custom node component
    │   ├── Background
    │   ├── Controls
    │   └── MiniMap
    ├── ProcessLegend      # Color legend overlay
    ├── ActivityDetailPanel # Read-only detail sidebar
    ├── ActivityEditPanel   # Editable form sidebar
    └── NewEdgeDialog      # Predicate picker modal
```

### Graph Layout

The graph uses a **longest-path layering** algorithm for left-to-right DAG layout:

1. Build adjacency from causal associations
2. DFS to compute longest path to any leaf for each node
3. Reverse layers so roots appear on the left
4. Group nodes by layer and space vertically

### Color System

- **12-color palette** for biological processes (colorblind-friendly)
- **Edge colors**: green (positive regulation), red (negative regulation), gray (other)
- Colors assigned by unique biological process term per model

### State Management

- **TanStack Query** for server state (model data, graph data, predicates)
- **React Flow's `useNodesState`/`useEdgesState`** for graph UI state
- **Local `useState`** for panel visibility, edit mode, form fields
- **Query invalidation** after mutations to refresh the graph

## Data Source

Models are fetched from two GO API endpoints:

- **Index**: `https://go-public.s3.amazonaws.com/files/gocam-models.json` — lightweight listing of all models
- **Models**: `https://api.geneontology.org/api/go-cam/{id}` — full Minerva JSON for individual models

The `gocam` package's `MinervaWrapper` handles fetching and translating the Minerva JSON format into typed Pydantic models.

## Comparison with Legacy Noctua Editor

| Aspect | Legacy Noctua | GO-CAM Mega Editor |
|--------|--------------|-------------------|
| Framework | Angular 18 | React 19 + Vite |
| Graph library | JointJS + ngx-graph | React Flow |
| API layer | BBOP client → Barista → Minerva | gocam package → GO API |
| Data model | Client-side RDF triple translation | Server-side Pydantic models |
| Validation | Client-side ShEx | Server-side (planned) |
| Scope | Single model | Multi-model mega-graphs |
| State management | RxJS + full model rebuild | TanStack Query + incremental |
