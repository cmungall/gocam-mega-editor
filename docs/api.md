# API Reference

The backend exposes a REST API on port `8484`. The frontend proxies `/api/*` requests to the backend.

## Read Endpoints

### `GET /models`

List available GO-CAM models from the GO public index.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | int | 100 | Max models to return (1-5000) |
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

### `GET /model/{model_id}/changes`

Return semantic changes recorded for the model.

```json
[
  {
    "id": "chg_ab12cd34ef56",
    "model_id": "568b0f9600000284",
    "created_at": "2026-04-05T19:30:00Z",
    "author_type": "human",
    "author_id": "local-user",
    "status": "applied",
    "operation_type": "set_molecular_function",
    "target": {"activity_id": "activity_2", "field": "molecular_function"},
    "before": {"term": "GO:0003674", "label": "molecular_function"},
    "after": {"term": "GO:0004674", "label": "protein serine/threonine kinase activity"},
    "inverse": {"molecular_function_term": "GO:0003674", "molecular_function_label": "molecular_function"},
    "summary": "Changed molecular function on activity_2: molecular_function -> protein serine/threonine kinase activity"
  }
]
```

### `POST /model/{model_id}/changes/{change_id}/revert`

Apply the stored inverse for a specific change.

### `POST /model/{model_id}/changes/undo`

Undo the most recent applied root change for the model.

### `POST /model/{model_id}/changes/redo`

Redo the most recently undone root change for the model.

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

### `GET /connected-models`

Discover same-species model-to-model links using fast indexed criteria.

| Parameter | Type | Description |
|-----------|------|-------------|
| `model_id` | string (repeatable) | Optional subset of model IDs to scan |
| `criteria` | string (repeatable) | Optional link criteria filter |
| `min_score` | int | Optional minimum link score |

Supported criteria are `shared_gene`, `gene_mf`, `full_activity_signature`, `terminal_to_initial`, `shared_chemical`, and `chemical_flow`.

```
GET /connected-models?criteria=full_activity_signature&criteria=chemical_flow&min_score=60
```

Edges include `criteria`, `score`, and `direction` in addition to the legacy `shared_genes` and `weight` fields.

### `GET /model/{model_id}/connections`

Return neighboring model links for one model. The response includes legacy gene-centered `connections`, plus `linked_models` and typed `model_links` for non-gene criteria such as non-currency CHEBI overlap and chemical output-to-input flow.

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
  "enabled_by_label": "some gene",
  "molecular_function_term": "GO:0004674",
  "molecular_function_label": "protein serine/threonine kinase activity",
  "biological_process_term": "GO:0008150",
  "biological_process_label": "biological_process",
  "occurs_in_term": "GO:0005737",
  "occurs_in_label": "cytoplasm",
  "evidence": [
    {
      "term": "ECO:0000314",
      "term_label": "direct assay evidence",
      "reference": "PMID:12345678",
      "with_objects": ["UniProtKB:Q99999"]
    }
  ]
}
```

All fields are optional. `evidence` can be sent on its own, and the backend applies it across the editable activity assertions that are present on the activity.

Each successful write also records one or more semantic `Change` objects that can be inspected via `GET /model/{model_id}/changes`.

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

!!! note "Local Persistence"
    Local edits and change history are persisted in `.gocam-state/` so they survive backend restarts on the same machine. This is still a local overlay, not upstream Minerva write-back.
