"""Core service layer for GO-CAM model operations.

The service owns business logic (graph translation, activity mutation).
Storage is delegated to a ModelAdapter implementation.
"""

import logging
from collections import defaultdict
from dataclasses import dataclass, field

import networkx as nx
from gocam.datamodel import (
    Activity,
    BiologicalProcessAssociation,
    CausalAssociation,
    CellularAnatomicalEntityAssociation,
    EnabledByGeneProductAssociation,
    EvidenceItem,
    Model,
    MolecularFunctionAssociation,
)
from gocam.translation.networkx.model_network_translator import ModelNetworkTranslator

from gocam_mega_editor.adapters import MinervaAdapter, ModelAdapter
from gocam_mega_editor.models import (
    ActivityUpdate,
    CausalEdgeCreate,
    ConnectedModels,
    EvidenceInput,
    GraphEdge,
    GraphNode,
    MegaGraph,
    ModelSummary,
    SharedGene,
)

logger = logging.getLogger(__name__)


@dataclass
class GoCamService:
    """Service for loading, querying, and editing GO-CAM models.

    All storage is delegated to the adapter. The service handles
    graph translation, activity mutation, and response formatting.
    """

    adapter: ModelAdapter = field(default_factory=MinervaAdapter)
    translator: ModelNetworkTranslator = field(default_factory=ModelNetworkTranslator)

    def list_models(self, limit: int = 100, offset: int = 0) -> list[ModelSummary]:
        """List available GO-CAM models from the adapter."""
        entries = self.adapter.list_summaries(limit=limit, offset=offset)
        summaries = []
        for entry in entries:
            gocam_url = entry.get("gocam", "")
            model_id = gocam_url.replace("http://model.geneontology.org/", "")
            summaries.append(
                ModelSummary(
                    id=model_id,
                    title=entry.get("title", ""),
                    taxon=entry.get("taxon", None),
                    status=entry.get("state", None),
                    date=entry.get("date", None),
                    contributors=entry.get("names", []),
                    groups=entry.get("groupnames", []),
                    activity_count=0,
                )
            )
        return summaries

    def get_model(self, model_id: str) -> Model:
        """Fetch a single GO-CAM model via the adapter."""
        model = self.adapter.get(model_id)
        if model is None:
            raise ValueError(f"Model {model_id} not found")
        return model

    def _find_activity(self, model: Model, activity_id: str) -> Activity:
        """Find an activity by ID within a model, or raise ValueError."""
        for activity in model.activities or []:
            if activity.id == activity_id:
                return activity
        raise ValueError(f"Activity {activity_id} not found in model {model.id}")

    @staticmethod
    def _build_evidence(inputs: list[EvidenceInput]) -> list[EvidenceItem]:
        return [
            EvidenceItem(
                term=ev.term,
                reference=ev.reference,
                with_objects=ev.with_objects,
            )
            for ev in inputs
        ]

    def update_activity(self, model_id: str, activity_id: str, update: ActivityUpdate) -> Activity:
        """Apply a partial update to an activity, then persist via adapter."""
        model = self.get_model(model_id)
        activity = self._find_activity(model, activity_id)

        if update.enabled_by_term is not None:
            activity.enabled_by = EnabledByGeneProductAssociation(
                term=update.enabled_by_term,
                evidence=self._build_evidence(update.evidence) if update.evidence else None,
            )
        if update.molecular_function_term is not None:
            evidence = self._build_evidence(update.evidence) if update.evidence else None
            activity.molecular_function = MolecularFunctionAssociation(
                term=update.molecular_function_term,
                evidence=evidence,
            )
        if update.biological_process_term is not None:
            evidence = self._build_evidence(update.evidence) if update.evidence else None
            activity.part_of = BiologicalProcessAssociation(
                term=update.biological_process_term,
                evidence=evidence,
            )
        if update.occurs_in_term is not None:
            evidence = self._build_evidence(update.evidence) if update.evidence else None
            activity.occurs_in = CellularAnatomicalEntityAssociation(
                term=update.occurs_in_term,
                evidence=evidence,
            )

        self.adapter.save(model)
        return activity

    def add_causal_edge(self, model_id: str, edge: CausalEdgeCreate) -> CausalAssociation:
        """Add a causal association between two activities, then persist."""
        model = self.get_model(model_id)
        source = self._find_activity(model, edge.source_activity_id)
        self._find_activity(model, edge.target_activity_id)

        assoc = CausalAssociation(
            predicate=edge.predicate,
            downstream_activity=edge.target_activity_id,
        )
        if source.causal_associations is None:
            source.causal_associations = []
        source.causal_associations.append(assoc)

        self.adapter.save(model)
        return assoc

    def delete_causal_edge(
        self, model_id: str, source_activity_id: str, target_activity_id: str
    ) -> None:
        """Remove a causal association between two activities, then persist."""
        model = self.get_model(model_id)
        source = self._find_activity(model, source_activity_id)
        if source.causal_associations:
            source.causal_associations = [
                ca
                for ca in source.causal_associations
                if ca.downstream_activity != target_activity_id
            ]
        self.adapter.save(model)

    def find_connected_models(self, model_ids: list[str] | None = None) -> ConnectedModels:
        """Find models that share gene products.

        If model_ids is provided, only look at those models.
        Otherwise, scan all models in the adapter.
        """
        if model_ids is None:
            model_ids = self.adapter.list_ids()

        gene_to_models: dict[str, list[str]] = defaultdict(list)
        gene_labels: dict[str, str] = {}

        for mid in model_ids:
            model = self.adapter.get(mid)
            if not model:
                continue
            for act in model.activities or []:
                if act.enabled_by and act.enabled_by.term:
                    gene = act.enabled_by.term
                    gene_to_models[gene].append(mid)
                    # Try to resolve label
                    if gene not in gene_labels and model.objects:
                        for obj in model.objects:
                            if obj.id == gene and obj.label:
                                gene_labels[gene] = obj.label
                                break

        shared = [
            SharedGene(
                gene_id=gene,
                label=gene_labels.get(gene),
                model_ids=sorted(set(mids)),
            )
            for gene, mids in gene_to_models.items()
            if len(set(mids)) > 1
        ]
        shared.sort(key=lambda g: len(g.model_ids), reverse=True)

        connected_model_ids = sorted({mid for g in shared for mid in g.model_ids})

        return ConnectedModels(
            shared_genes=shared,
            model_ids=connected_model_ids,
            connection_count=len(shared),
        )

    def get_mega_graph(self, model_ids: list[str]) -> MegaGraph:
        """Build an interconnected graph from multiple models."""
        models = [self.get_model(mid) for mid in model_ids]
        nx_graph: nx.DiGraph = self.translator.translate_models(models)

        nodes = []
        for node_id, attrs in nx_graph.nodes(data=True):
            nodes.append(
                GraphNode(
                    id=str(node_id),
                    label=attrs.get("label"),
                    gene_product=attrs.get("gene_product"),
                    model_id=attrs.get("model_id"),
                )
            )

        edges = []
        for src, tgt, attrs in nx_graph.edges(data=True):
            edges.append(
                GraphEdge(
                    source=str(src),
                    target=str(tgt),
                    causal_predicate=attrs.get("causal_predicate"),
                    model_id=attrs.get("model_id"),
                )
            )

        return MegaGraph(
            nodes=nodes,
            edges=edges,
            model_count=len(models),
            node_count=len(nodes),
            edge_count=len(edges),
        )
