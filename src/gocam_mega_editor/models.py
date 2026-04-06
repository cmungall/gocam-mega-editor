"""Pydantic response models for the API."""

from typing import Any

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
    term_label: str | None = None
    reference: str | None = None
    with_objects: list[str] | None = None


class ActivityUpdate(BaseModel):
    """Partial update to an activity's associations."""

    enabled_by_term: str | None = None
    enabled_by_label: str | None = None
    molecular_function_term: str | None = None
    molecular_function_label: str | None = None
    biological_process_term: str | None = None
    biological_process_label: str | None = None
    occurs_in_term: str | None = None
    occurs_in_label: str | None = None
    evidence: list[EvidenceInput] | None = None


class ChangeRecord(BaseModel):
    """A semantic change applied to a GO-CAM model."""

    id: str
    model_id: str
    created_at: str
    author_type: str = "human"
    author_id: str | None = "local-user"
    status: str = "applied"
    operation_type: str
    target: dict[str, Any]
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    inverse: dict[str, Any] | None = None
    summary: str
    metadata: dict[str, Any] | None = None


class GeneConnection(BaseModel):
    """A gene product in this model that also appears in other models."""

    gene_id: str
    label: str | None = None
    other_models: list[ModelSummary]


class ModelConnections(BaseModel):
    """Cross-model connections for a single model."""

    model_id: str
    connections: list[GeneConnection]


class CausalEdgeCreate(BaseModel):
    """Create a new causal association between two activities."""

    source_activity_id: str
    target_activity_id: str
    predicate: str


class SharedGene(BaseModel):
    """A gene product shared between models."""

    gene_id: str
    label: str | None = None
    model_ids: list[str]


class ModelNode(BaseModel):
    """A model as a node in the mega-graph."""

    id: str
    title: str
    taxon: str | None = None
    activity_count: int = 0


class ModelEdge(BaseModel):
    """An edge between two models (shared gene products)."""

    source: str
    target: str
    shared_genes: list[SharedGene]
    weight: int  # number of shared genes


class SpeciesCluster(BaseModel):
    """A cluster of connected models within a single species."""

    taxon: str | None = None
    taxon_label: str | None = None
    models: list[ModelNode]
    edges: list[ModelEdge]


class ConnectedModels(BaseModel):
    """Discovery result: models grouped by species with inter-model edges."""

    species_clusters: list[SpeciesCluster]
    total_models: int
    total_connections: int
