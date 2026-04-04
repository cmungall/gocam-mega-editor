"""Pydantic response models for the API."""

from pydantic import BaseModel


class ModelSummary(BaseModel):
    """Lightweight summary of a GO-CAM model for listing."""

    id: str
    title: str
    taxon: str | None = None
    status: str | None = None
    date: str | None = None
    contributors: list[str] = []
    groups: list[str] = []
    activity_count: int = 0


class GraphNode(BaseModel):
    """A node in the mega-graph (gene product)."""

    id: str
    label: str | None = None
    gene_product: str | None = None
    model_id: str | None = None


class GraphEdge(BaseModel):
    """An edge in the mega-graph (causal relationship).

    When multiple models share the same gene-gene edge, attributes
    get merged into lists by the NetworkX translator.
    """

    source: str
    target: str
    causal_predicate: str | list[str] | None = None
    model_id: str | list[str] | None = None


class MegaGraph(BaseModel):
    """The interconnected mega-graph across multiple models."""

    nodes: list[GraphNode]
    edges: list[GraphEdge]
    model_count: int
    node_count: int
    edge_count: int


class EvidenceInput(BaseModel):
    """Evidence for an assertion."""

    term: str | None = None
    reference: str | None = None
    with_objects: list[str] | None = None


class ActivityUpdate(BaseModel):
    """Partial update to an activity's associations."""

    enabled_by_term: str | None = None
    molecular_function_term: str | None = None
    biological_process_term: str | None = None
    occurs_in_term: str | None = None
    evidence: list[EvidenceInput] | None = None


class CausalEdgeCreate(BaseModel):
    """Create a new causal association between two activities."""

    source_activity_id: str
    target_activity_id: str
    predicate: str
