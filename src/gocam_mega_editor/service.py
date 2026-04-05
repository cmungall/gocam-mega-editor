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
    GeneConnection,
    GraphEdge,
    GraphNode,
    MegaGraph,
    ModelConnections,
    ModelEdge,
    ModelNode,
    ModelSummary,
    SharedGene,
    SpeciesCluster,
)

logger = logging.getLogger(__name__)

EDITABLE_ACTIVITY_ASSOCIATIONS = (
    "enabled_by",
    "molecular_function",
    "part_of",
    "occurs_in",
)


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

    @staticmethod
    def _current_evidence(activity: Activity, association_name: str) -> list[EvidenceItem] | None:
        association = getattr(activity, association_name, None)
        return association.evidence if association else None

    @staticmethod
    def _apply_shared_evidence(activity: Activity, evidence: list[EvidenceItem]) -> None:
        for association_name in EDITABLE_ACTIVITY_ASSOCIATIONS:
            association = getattr(activity, association_name, None)
            if association is not None:
                association.evidence = evidence

    def update_activity(self, model_id: str, activity_id: str, update: ActivityUpdate) -> Activity:
        """Apply a partial update to an activity, then persist via adapter."""
        model = self.get_model(model_id)
        activity = self._find_activity(model, activity_id)
        evidence = self._build_evidence(update.evidence) if update.evidence is not None else None

        if update.enabled_by_term is not None:
            activity.enabled_by = (
                EnabledByGeneProductAssociation(
                    term=update.enabled_by_term,
                    evidence=evidence if update.evidence is not None else self._current_evidence(activity, "enabled_by"),
                )
                if update.enabled_by_term
                else None
            )
        if update.molecular_function_term is not None:
            activity.molecular_function = (
                MolecularFunctionAssociation(
                    term=update.molecular_function_term,
                    evidence=evidence if update.evidence is not None else self._current_evidence(activity, "molecular_function"),
                )
                if update.molecular_function_term
                else None
            )
        if update.biological_process_term is not None:
            activity.part_of = (
                BiologicalProcessAssociation(
                    term=update.biological_process_term,
                    evidence=evidence if update.evidence is not None else self._current_evidence(activity, "part_of"),
                )
                if update.biological_process_term
                else None
            )
        if update.occurs_in_term is not None:
            activity.occurs_in = (
                CellularAnatomicalEntityAssociation(
                    term=update.occurs_in_term,
                    evidence=evidence if update.evidence is not None else self._current_evidence(activity, "occurs_in"),
                )
                if update.occurs_in_term
                else None
            )
        if update.evidence is not None:
            self._apply_shared_evidence(activity, evidence)

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
        self,
        model_id: str,
        source_activity_id: str,
        target_activity_id: str,
        predicate: str | None = None,
    ) -> None:
        """Remove a causal association between two activities, then persist."""
        model = self.get_model(model_id)
        source = self._find_activity(model, source_activity_id)
        if source.causal_associations:
            source.causal_associations = [
                ca
                for ca in source.causal_associations
                if ca.downstream_activity != target_activity_id
                or (predicate is not None and ca.predicate != predicate)
            ]
        self.adapter.save(model)

    def get_model_connections(self, model_id: str) -> ModelConnections:
        """Find which gene products in this model also appear in other models.

        Only considers same-species models.
        """
        model = self.get_model(model_id)
        taxon = model.taxon

        # Collect this model's gene products
        my_genes: dict[str, str | None] = {}
        for act in model.activities or []:
            if act.enabled_by and act.enabled_by.term:
                gene = act.enabled_by.term
                label = None
                if model.objects:
                    for obj in model.objects:
                        if obj.id == gene and obj.label:
                            label = obj.label
                            break
                my_genes[gene] = label

        # Scan other models for matches
        gene_other_models: dict[str, list[ModelSummary]] = defaultdict(list)
        for other_id in self.adapter.list_ids():
            if other_id == model_id:
                continue
            other = self.adapter.get(other_id)
            if not other or other.taxon != taxon:
                continue
            other_genes = {
                act.enabled_by.term
                for act in (other.activities or [])
                if act.enabled_by and act.enabled_by.term
            }
            shared = other_genes & my_genes.keys()
            if shared:
                summary = ModelSummary(
                    id=other_id,
                    title=other.title or other_id,
                    taxon=other.taxon,
                    activity_count=len(other.activities or []),
                )
                for gene in shared:
                    gene_other_models[gene].append(summary)

        connections = [
            GeneConnection(
                gene_id=gene,
                label=my_genes.get(gene),
                other_models=models,
            )
            for gene, models in sorted(gene_other_models.items(), key=lambda x: len(x[1]), reverse=True)
        ]

        return ModelConnections(model_id=model_id, connections=connections)

    def find_connected_models(self, model_ids: list[str] | None = None) -> ConnectedModels:
        """Find models that share gene products, grouped by species.

        Only same-species gene sharing counts as a real connection.
        """
        if model_ids is None:
            model_ids = self.adapter.list_ids()

        # Collect model metadata + gene->model mapping
        model_info: dict[str, dict] = {}
        gene_to_models: dict[str, list[str]] = defaultdict(list)
        gene_labels: dict[str, str] = {}

        for mid in model_ids:
            model = self.adapter.get(mid)
            if not model:
                continue
            taxon = model.taxon
            # Resolve taxon label
            taxon_label = None
            if taxon and model.objects:
                for obj in model.objects:
                    if obj.id == taxon and obj.label:
                        taxon_label = obj.label
                        break
            model_info[mid] = {
                "title": model.title or mid,
                "taxon": taxon,
                "taxon_label": taxon_label,
                "activity_count": len(model.activities or []),
            }
            for act in model.activities or []:
                if act.enabled_by and act.enabled_by.term:
                    gene = act.enabled_by.term
                    gene_to_models[gene].append(mid)
                    if gene not in gene_labels and model.objects:
                        for obj in model.objects:
                            if obj.id == gene and obj.label:
                                gene_labels[gene] = obj.label
                                break

        # Group models by species
        species_models: dict[str | None, list[str]] = defaultdict(list)
        for mid, info in model_info.items():
            species_models[info["taxon"]].append(mid)

        # Build per-species clusters
        clusters: list[SpeciesCluster] = []
        total_connections = 0

        for taxon, mids in sorted(species_models.items(), key=lambda x: len(x[1]), reverse=True):
            mid_set = set(mids)
            # Find model-to-model edges via shared genes (same species only)
            pair_genes: dict[tuple[str, str], list[SharedGene]] = defaultdict(list)
            for gene, gene_mids in gene_to_models.items():
                same_species = [m for m in gene_mids if m in mid_set]
                unique = sorted(set(same_species))
                if len(unique) < 2:
                    continue
                sg = SharedGene(gene_id=gene, label=gene_labels.get(gene), model_ids=unique)
                from itertools import combinations
                for a, b in combinations(unique, 2):
                    pair_genes[(a, b)].append(sg)

            edges = [
                ModelEdge(
                    source=a,
                    target=b,
                    shared_genes=genes,
                    weight=len(genes),
                )
                for (a, b), genes in sorted(pair_genes.items(), key=lambda x: len(x[1]), reverse=True)
            ]

            # Only include models that have connections (or all if no connections)
            connected_mids = {m for e in edges for m in (e.source, e.target)}
            include_mids = connected_mids if connected_mids else set(mids)

            nodes = [
                ModelNode(
                    id=mid,
                    title=model_info[mid]["title"],
                    taxon=model_info[mid]["taxon"],
                    activity_count=model_info[mid]["activity_count"],
                )
                for mid in sorted(include_mids)
            ]

            taxon_label = None
            if mids and model_info[mids[0]].get("taxon_label"):
                taxon_label = model_info[mids[0]]["taxon_label"]

            total_connections += len(edges)
            clusters.append(
                SpeciesCluster(
                    taxon=taxon,
                    taxon_label=taxon_label,
                    models=nodes,
                    edges=edges,
                )
            )

        return ConnectedModels(
            species_clusters=clusters,
            total_models=len(model_info),
            total_connections=total_connections,
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
