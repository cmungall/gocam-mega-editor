# API Reference

The backend exposes a REST API on port 8000. The frontend proxies `/api/*` requests to the backend.

## Read Endpoints

### `GET /models`

List available GO-CAM models from the GO public index.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | int | 100 | Max models to return (1-1000) |
| `offset` | int | 0 | Pagination offset |

```json
[
  {
    "id": "568b0f9600000284",
    "title": "Antibacterial innate immune response...",
    "taxon": null,
    "status": null,
    "date": "2026-03-12",
    "contributors": ["Kimberly Van Auken", "Marie-Claire Harrison"],
    "groups": ["WB"],
    "activity_count": 0
  }
]
```

### `GET /model/{model_id}`

Fetch a full GO-CAM model as JSON. Includes activities, associations, evidence, objects, and provenance. Predicate labels are injected into the objects list for frontend label resolution.

### `GET /graph`

Build an interconnected gene-to-gene mega-graph from one or more models.

| Parameter | Type | Description |
|-----------|------|-------------|
| `model_id` | string (repeatable) | Model IDs to include |

```
GET /graph?model_id=568b0f9600000284&model_id=5745387b00001516
```

```json
{
  "nodes": [
    {"id": "WB:WBGene00006575", "label": "tir-1 Cele", "gene_product": "WB:WBGene00006575", "model_id": "gomodel:568b0f9600000284"}
  ],
  "edges": [
    {"source": "WB:WBGene00006575", "target": "WB:WBGene00004789", "causal_predicate": "RO:0002629", "model_id": "gomodel:568b0f9600000284"}
  ],
  "model_count": 2,
  "node_count": 20,
  "edge_count": 19
}
```

### `GET /predicates`

List available causal predicates with human-readable labels.

```json
{
  "RO:0002629": "directly positively regulates",
  "RO:0002630": "directly negatively regulates",
  "RO:0002413": "provides input for"
}
```

### `GET /health`

Health check. Returns `{"status": "ok"}`.

## Write Endpoints

### `PATCH /model/{model_id}/activity/{activity_id}`

Update an activity's associations and evidence.

```json
{
  "enabled_by_term": "UniProtKB:P12345",
  "molecular_function_term": "GO:0004674",
  "biological_process_term": "GO:0008150",
  "occurs_in_term": "GO:0005737",
  "evidence": [
    {
      "term": "ECO:0000314",
      "reference": "PMID:12345678",
      "with_objects": ["UniProtKB:Q99999"]
    }
  ]
}
```

All fields are optional. `evidence` can be sent on its own, and the backend applies it across the editable activity assertions that are present on the activity.

### `POST /model/{model_id}/causal-edge`

Create a new causal association between two activities.

```json
{
  "source_activity_id": "gomodel:568b0f9600000284/57ec3a7e00000079",
  "target_activity_id": "gomodel:568b0f9600000284/57ec3a7e00000109",
  "predicate": "RO:0002629"
}
```

### `DELETE /model/{model_id}/causal-edge`

Remove a causal association.

| Parameter | Type | Description |
|-----------|------|-------------|
| `source_activity_id` | string | Source activity ID |
| `target_activity_id` | string | Target activity ID |
| `predicate` | string (optional) | Remove only the matching predicate when multiple edges connect the same activities |

!!! note "Persistence"
    All write operations currently persist to the in-memory model cache. Changes are lost when the server restarts. A future iteration will add Minerva write-back for permanent persistence.
