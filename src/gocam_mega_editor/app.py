"""FastAPI application for the GO-CAM Mega Editor backend."""

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from pydantic import BaseModel as PydanticBaseModel

from gocam_mega_editor.adapters import InMemoryAdapter, MinervaAdapter, OverlayAdapter
from gocam_mega_editor.lookup import OntologyLookup
from gocam_mega_editor.models import (
    ActivityUpdate,
    CausalEdgeCreate,
    ChangeRecord,
    ConnectedModels,
    MegaGraph,
    ModelConnections,
    ModelSummary,
)
from gocam_mega_editor.service import GoCamService

# Common RO relation labels for causal predicates used in GO-CAM
PREDICATE_LABELS: dict[str, str] = {
    "RO:0002211": "regulates",
    "RO:0002212": "negatively regulates",
    "RO:0002213": "positively regulates",
    "RO:0002304": "causally upstream of, positive effect",
    "RO:0002305": "causally upstream of, negative effect",
    "RO:0002411": "causally upstream of",
    "RO:0002413": "provides input for",
    "RO:0002629": "directly positively regulates",
    "RO:0002630": "directly negatively regulates",
    "RO:0002408": "directly inhibits",
    "RO:0002406": "directly activates",
    "RO:0012012": "removed from",
    "RO:0012010": "removes input for",
}

app = FastAPI(
    title="GO-CAM Mega Editor API",
    description="Backend API for the visual GO-CAM pathway mega-editor",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _make_adapter():
    """Build adapter from GOCAM_ADAPTER env var.

    Values:
        auto — prefer local file corpus with local overlay, fall back to Minerva
        minerva (default) — read from GO API, write to in-memory cache
        memory — pure in-memory (no external calls)
        file:/path/to/dir — in-memory + JSON file persistence
        minerva:https://custom-endpoint/ — custom Minerva endpoint
    """
    spec = os.environ.get("GOCAM_ADAPTER", "minerva")
    local_state_dir = os.environ.get("GOCAM_LOCAL_STATE_DIR")
    model_storage_dir = Path(local_state_dir) / "models" if local_state_dir else None

    def build_file_adapter(storage_dir: Path) -> InMemoryAdapter | OverlayAdapter:
        base = InMemoryAdapter(storage_dir=storage_dir)
        if model_storage_dir is None:
            return base
        if model_storage_dir.resolve() == storage_dir.resolve():
            return base
        return OverlayAdapter(base=base, overlay=InMemoryAdapter(storage_dir=model_storage_dir))

    if spec == "auto":
        default_data_dir = Path("data/models")
        if default_data_dir.exists():
            return build_file_adapter(default_data_dir)
        return MinervaAdapter(storage_dir=model_storage_dir)
    if spec == "memory":
        return InMemoryAdapter()
    if spec.startswith("file:"):
        return build_file_adapter(Path(spec.removeprefix("file:")))
    if spec.startswith("minerva:"):
        return MinervaAdapter(
            endpoint_base=spec.removeprefix("minerva:"),
            storage_dir=model_storage_dir,
        )
    return MinervaAdapter(storage_dir=model_storage_dir)


def _make_change_log_dir() -> Path | None:
    local_state_dir = os.environ.get("GOCAM_LOCAL_STATE_DIR")
    if not local_state_dir:
        return None
    return Path(local_state_dir) / "changes"


service = GoCamService(adapter=_make_adapter(), change_log_dir=_make_change_log_dir())
lookup = OntologyLookup()


class AutocompleteRequest(PydanticBaseModel):
    field: str
    query: str
    taxon: str | None = None
    limit: int = 10


class AutocompleteItem(PydanticBaseModel):
    id: str
    label: str
    category: str | None = None


@app.post("/autocomplete", response_model=list[AutocompleteItem])
def autocomplete(req: AutocompleteRequest) -> list[AutocompleteItem]:
    """Field-aware ontology/gene product autocomplete.

    Routes to OLS (ontology terms) or UniProt (gene products) based
    on the field type, with branch constraints from the GO-CAM schema.

    Fields: enabled_by, molecular_function, biological_process, occurs_in, evidence
    """
    results = lookup.search(req.field, req.query, taxon=req.taxon, limit=req.limit)
    return [AutocompleteItem(id=r.id, label=r.label, category=r.category) for r in results]


@app.get("/models", response_model=list[ModelSummary])
def list_models(
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> list[ModelSummary]:
    """List available GO-CAM models."""
    return service.list_models(limit=limit, offset=offset)


@app.get("/model/{model_id}")
def get_model(model_id: str) -> dict:
    """Fetch a single GO-CAM model as JSON.

    Returns the full gocam Model serialized via Pydantic,
    enriched with predicate labels in the objects list.
    """
    model = service.get_model(model_id)
    summary = service.get_model_summary(model_id)
    data = model.model_dump(exclude_none=True)
    if summary is not None:
        data["summary"] = summary.model_dump(exclude_none=True)

    # Inject predicate labels into objects so the frontend can resolve them
    existing_ids = {obj["id"] for obj in data.get("objects", [])}
    if "objects" not in data:
        data["objects"] = []
    for pred_id, pred_label in PREDICATE_LABELS.items():
        if pred_id not in existing_ids:
            data["objects"].append({"id": pred_id, "label": pred_label})
    return data


@app.get("/model/{model_id}/connections", response_model=ModelConnections)
def model_connections(model_id: str) -> ModelConnections:
    """Find gene products in this model that also appear in other same-species models."""
    return service.get_model_connections(model_id)


@app.get("/model/{model_id}/changes", response_model=list[ChangeRecord])
def model_changes(model_id: str) -> list[ChangeRecord]:
    """Return semantic changes recorded for a model."""
    try:
        return service.get_model_changes(model_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/model/{model_id}/changes/{change_id}/revert", response_model=ChangeRecord)
def revert_model_change(model_id: str, change_id: str) -> ChangeRecord:
    """Apply the inverse of a previously recorded change."""
    try:
        return service.revert_change(model_id, change_id)
    except ValueError as e:
        message = str(e)
        status_code = 404 if "not found" in message.lower() else 400
        raise HTTPException(status_code=status_code, detail=message)


@app.post("/model/{model_id}/changes/undo", response_model=ChangeRecord)
def undo_last_model_change(model_id: str) -> ChangeRecord:
    """Undo the most recent applied change for a model."""
    try:
        return service.undo_last_change(model_id)
    except ValueError as e:
        message = str(e)
        status_code = 404 if "not found" in message.lower() else 400
        raise HTTPException(status_code=status_code, detail=message)


@app.post("/model/{model_id}/changes/redo", response_model=ChangeRecord)
def redo_last_model_change(model_id: str) -> ChangeRecord:
    """Redo the most recent redoable change for a model."""
    try:
        return service.redo_last_change(model_id)
    except ValueError as e:
        message = str(e)
        status_code = 404 if "not found" in message.lower() else 400
        raise HTTPException(status_code=status_code, detail=message)


@app.get("/connected-models", response_model=ConnectedModels)
def connected_models(
    model_ids: list[str] | None = Query(default=None, alias="model_id"),
) -> ConnectedModels:
    """Discover models that share gene products.

    Without model_id params, scans all models in the adapter.
    With model_id params, only scans those models.
    """
    return service.find_connected_models(model_ids)


@app.get("/graph", response_model=MegaGraph)
def get_graph(
    model_ids: list[str] = Query(alias="model_id"),
) -> MegaGraph:
    """Build an interconnected mega-graph from multiple GO-CAM models.

    Pass one or more model_id query params:
        /graph?model_id=abc&model_id=def
    """
    return service.get_mega_graph(model_ids)


@app.patch("/model/{model_id}/activity/{activity_id:path}")
def update_activity(model_id: str, activity_id: str, update: ActivityUpdate) -> dict:
    """Update an activity's associations (gene product, MF, BP, CC, evidence)."""
    try:
        activity = service.update_activity(model_id, activity_id, update)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return activity.model_dump(exclude_none=True)


@app.post("/model/{model_id}/causal-edge")
def create_causal_edge(model_id: str, edge: CausalEdgeCreate) -> dict:
    """Create a new causal association between two activities."""
    try:
        assoc = service.add_causal_edge(model_id, edge)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return assoc.model_dump(exclude_none=True)


@app.delete("/model/{model_id}/causal-edge")
def delete_causal_edge(
    model_id: str,
    source_activity_id: str = Query(),
    target_activity_id: str = Query(),
    predicate: str | None = Query(default=None),
) -> dict:
    """Delete a causal association between two activities."""
    try:
        service.delete_causal_edge(model_id, source_activity_id, target_activity_id, predicate)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"status": "deleted"}


@app.get("/predicates")
def list_predicates() -> dict[str, str]:
    """List available causal predicates with labels."""
    return PREDICATE_LABELS


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
