"""FastAPI application for the GO-CAM Mega Editor backend."""

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from gocam_mega_editor.models import MegaGraph, ModelSummary
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

service = GoCamService()


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
    data = model.model_dump(exclude_none=True)

    # Inject predicate labels into objects so the frontend can resolve them
    existing_ids = {obj["id"] for obj in data.get("objects", [])}
    if "objects" not in data:
        data["objects"] = []
    for pred_id, pred_label in PREDICATE_LABELS.items():
        if pred_id not in existing_ids:
            data["objects"].append({"id": pred_id, "label": pred_label})
    return data


@app.get("/graph", response_model=MegaGraph)
def get_graph(
    model_ids: list[str] = Query(alias="model_id"),
) -> MegaGraph:
    """Build an interconnected mega-graph from multiple GO-CAM models.

    Pass one or more model_id query params:
        /graph?model_id=abc&model_id=def
    """
    return service.get_mega_graph(model_ids)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
