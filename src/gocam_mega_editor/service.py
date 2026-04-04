"""Core service layer wrapping the gocam package."""

import logging
from dataclasses import dataclass, field

import networkx as nx
from gocam.datamodel import Model
from gocam.translation.minerva_wrapper import MinervaWrapper
from gocam.translation.networkx.model_network_translator import ModelNetworkTranslator

from gocam_mega_editor.models import GraphEdge, GraphNode, MegaGraph, ModelSummary

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
