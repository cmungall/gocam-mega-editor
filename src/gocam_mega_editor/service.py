"""Core service layer wrapping the gocam package."""

import logging
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
from gocam.translation.minerva_wrapper import MinervaWrapper
from gocam.translation.networkx.model_network_translator import ModelNetworkTranslator

from gocam_mega_editor.models import (
    ActivityUpdate,
    CausalEdgeCreate,
    EvidenceInput,
    GraphEdge,
    GraphNode,
    MegaGraph,
    ModelSummary,
)

logger = logging.getLogger(__name__)


@dataclass
class GoCamService:
    """Service for loading and querying GO-CAM models.

    Wraps MinervaWrapper with an in-memory cache and provides
    graph translation for the mega-model view.
    """

    wrapper: MinervaWrapper = field(default_factory=MinervaWrapper)
    translator: ModelNetworkTranslator = field(default_factory=ModelNetworkTranslator)
    _models: dict[str, Model] = field(default_factory=dict)
    _index: list[dict] | None = field(default=None)

    def _fetch_index(self) -> list[dict]:
        """Fetch the model index from the GO API."""
        if self._index is None:
            response = self.wrapper.session.get(self.wrapper.gocam_index_url)
            response.raise_for_status()
            self._index = response.json()
        return self._index

    def list_models(self, limit: int = 100, offset: int = 0) -> list[ModelSummary]:
        """List available GO-CAM models from the index.

        >>> svc = GoCamService()
        >>> summaries = svc.list_models(limit=2)
        >>> all(isinstance(s, ModelSummary) for s in summaries)
        True
        """
        index = self._fetch_index()
        page = index[offset : offset + limit]
        summaries = []
        for entry in page:
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
        """Fetch a single GO-CAM model, using cache if available."""
        if model_id not in self._models:
            self._models[model_id] = self.wrapper.fetch_model(model_id)
        return self._models[model_id]

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
        """Apply a partial update to an activity within a cached model."""
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

        return activity

    def add_causal_edge(self, model_id: str, edge: CausalEdgeCreate) -> CausalAssociation:
        """Add a causal association between two activities in a model."""
        model = self.get_model(model_id)
        source = self._find_activity(model, edge.source_activity_id)
        # Validate target exists
        self._find_activity(model, edge.target_activity_id)

        assoc = CausalAssociation(
            predicate=edge.predicate,
            downstream_activity=edge.target_activity_id,
        )
        if source.causal_associations is None:
            source.causal_associations = []
        source.causal_associations.append(assoc)
        return assoc

    def delete_causal_edge(
        self, model_id: str, source_activity_id: str, target_activity_id: str
    ) -> None:
        """Remove a causal association between two activities."""
        model = self.get_model(model_id)
        source = self._find_activity(model, source_activity_id)
        if source.causal_associations:
            source.causal_associations = [
                ca
                for ca in source.causal_associations
                if ca.downstream_activity != target_activity_id
            ]

    def get_mega_graph(self, model_ids: list[str]) -> MegaGraph:
        """Build an interconnected graph from multiple models.

        Fetches each model, translates them all into a single NetworkX DiGraph,
        then converts to our API response format.
        """
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
