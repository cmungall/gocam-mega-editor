"""Tests for fast cross-model link discovery."""

from time import perf_counter

from gocam.datamodel import (
    Activity,
    BiologicalProcessAssociation,
    CausalAssociation,
    CellularAnatomicalEntityAssociation,
    EnabledByGeneProductAssociation,
    Model,
    MolecularFunctionAssociation,
    MoleculeAssociation,
    Object,
)

from gocam_mega_editor.adapters import InMemoryAdapter
from gocam_mega_editor.service import GoCamService


def _activity(
    model_id: str,
    activity_id: str,
    gene: str,
    mf: str = "GO:0004674",
    bp: str = "GO:0007165",
    cc: str = "GO:0005886",
    downstream: str | None = None,
    molecule_predicate: str | None = None,
    molecule: str | None = None,
) -> Activity:
    molecular_associations = None
    if molecule_predicate and molecule:
        molecular_associations = [
            MoleculeAssociation(
                predicate=molecule_predicate,
                molecule=molecule,
            )
        ]

    causal_associations = None
    if downstream:
        causal_associations = [
            CausalAssociation(
                predicate="RO:0002411",
                downstream_activity=downstream,
            )
        ]

    return Activity(
        id=f"gomodel:{model_id}/{activity_id}",
        enabled_by=EnabledByGeneProductAssociation(term=gene),
        molecular_function=MolecularFunctionAssociation(term=mf),
        part_of=BiologicalProcessAssociation(term=bp),
        occurs_in=CellularAnatomicalEntityAssociation(term=cc),
        molecular_associations=molecular_associations,
        causal_associations=causal_associations,
    )


def _objects() -> list[Object]:
    return [
        Object(id="NCBITaxon:9606", label="Homo sapiens"),
        Object(id="UniProtKB:P12345", label="SharedGene"),
        Object(id="GO:0004674", label="protein kinase activity"),
        Object(id="GO:0007165", label="signal transduction"),
        Object(id="GO:0005886", label="plasma membrane"),
        Object(id="CHEBI:999999", label="specific test chemical"),
    ]


def test_find_connected_models_reports_fast_link_criteria():
    adapter = InMemoryAdapter()
    model_a = Model(
        id="gomodel:model-a",
        title="Upstream model",
        taxon="NCBITaxon:9606",
        objects=_objects(),
        activities=[
            _activity(
                "model-a",
                "upstream",
                "UniProtKB:A00001",
                downstream="gomodel:model-a/overlap",
            ),
            _activity(
                "model-a",
                "overlap",
                "UniProtKB:P12345",
                molecule_predicate="RO:0002234",
                molecule="CHEBI:999999",
            ),
        ],
    )
    model_b = Model(
        id="gomodel:model-b",
        title="Downstream model",
        taxon="NCBITaxon:9606",
        objects=_objects(),
        activities=[
            _activity(
                "model-b",
                "overlap",
                "UniProtKB:P12345",
                downstream="gomodel:model-b/downstream",
                molecule_predicate="RO:0002233",
                molecule="CHEBI:999999",
            ),
            _activity("model-b", "downstream", "UniProtKB:B00001"),
        ],
    )
    adapter.save(model_a)
    adapter.save(model_b)

    connected = GoCamService(adapter=adapter).find_connected_models()
    edge = connected.species_clusters[0].edges[0]
    criteria = {criterion.type for criterion in edge.criteria}

    assert edge.source == "model-a"
    assert edge.target == "model-b"
    assert edge.direction == "source_to_target"
    assert edge.weight == 1
    assert edge.score > 0
    assert criteria == {
        "shared_gene",
        "gene_mf",
        "full_activity_signature",
        "terminal_to_initial",
        "shared_chemical",
        "chemical_flow",
    }
    assert edge.shared_genes[0].gene_id == "UniProtKB:P12345"
    assert edge.criteria[0].anchors


def test_find_connected_models_filters_by_criteria_and_score():
    adapter = InMemoryAdapter()
    for model_id in ("model-a", "model-b"):
        adapter.save(
            Model(
                id=f"gomodel:{model_id}",
                title=model_id,
                taxon="NCBITaxon:9606",
                activities=[
                    _activity(
                        model_id,
                        "act",
                        "UniProtKB:P12345",
                        molecule_predicate="RO:0002233",
                        molecule="CHEBI:999999",
                    )
                ],
            )
        )

    service = GoCamService(adapter=adapter)
    chemical_only = service.find_connected_models(
        criteria=["shared_chemical"], min_score=20
    )
    assert chemical_only.total_connections == 1
    assert all(
        any(criterion.type == "shared_chemical" for criterion in edge.criteria)
        for cluster in chemical_only.species_clusters
        for edge in cluster.edges
    )

    no_match = service.find_connected_models(criteria=["chemical_flow"])
    assert no_match.total_connections == 0


def test_find_connected_models_handles_1000_models_under_10_seconds():
    adapter = InMemoryAdapter()
    for index in range(1000):
        group = index // 10
        model_id = f"model-{index:04d}"
        adapter.save(
            Model(
                id=f"gomodel:{model_id}",
                title=model_id,
                taxon="NCBITaxon:9606",
                activities=[
                    _activity(
                        model_id,
                        "act",
                        f"UniProtKB:GROUP{group:04d}",
                    )
                ],
            )
        )

    service = GoCamService(adapter=adapter)
    started = perf_counter()
    connected = service.find_connected_models()
    elapsed = perf_counter() - started

    assert connected.total_models == 1000
    assert connected.total_connections == 4500
    assert elapsed < 10
