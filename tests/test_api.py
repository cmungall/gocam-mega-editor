"""Tests for the FastAPI endpoints."""

from unittest.mock import MagicMock, patch

import pytest
from gocam.datamodel import (
    Activity,
    CausalAssociation,
    EnabledByGeneProductAssociation,
    Model,
    MolecularFunctionAssociation,
    Object,
)


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_list_models(client):
    resp = client.get("/models")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 3
    assert data[0]["id"] == "568b0f9600000284"
    assert data[0]["title"] == "Wnt signaling pathway"
    assert data[0]["taxon"] == "NCBITaxon:9606"
    assert data[0]["status"] == "production"


def test_list_models_pagination(client):
    resp = client.get("/models?limit=2&offset=1")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert data[0]["id"] == "5a6a859200000953"
    assert data[1]["id"] == "testmodel003"


def test_list_models_limit(client):
    resp = client.get("/models?limit=1")
    data = resp.json()
    assert len(data) == 1


def _make_fake_model(model_id: str = "568b0f9600000284") -> Model:
    """Build a minimal Model for testing."""
    obj_a = Object(id="UniProtKB:P12345", label="GeneA")
    obj_b = Object(id="UniProtKB:P67890", label="GeneB")
    obj_func = Object(id="GO:0003674", label="molecular_function")

    activity_a = Activity(
        id="activity_1",
        enabled_by=EnabledByGeneProductAssociation(term="UniProtKB:P12345"),
        molecular_function=MolecularFunctionAssociation(term="GO:0003674"),
        causal_associations=[
            CausalAssociation(
                predicate="RO:0002411",
                downstream_activity="activity_2",
            )
        ],
    )
    activity_b = Activity(
        id="activity_2",
        enabled_by=EnabledByGeneProductAssociation(term="UniProtKB:P67890"),
        molecular_function=MolecularFunctionAssociation(term="GO:0003674"),
    )

    return Model(
        id=f"gomodel:{model_id}",
        title="Test pathway",
        taxon="NCBITaxon:9606",
        status="production",
        activities=[activity_a, activity_b],
        objects=[obj_a, obj_b, obj_func],
    )


def test_get_model(client):
    fake_model = _make_fake_model()
    with patch.object(
        type(client.app.state) if hasattr(client.app, "state") else type(None),
        "__init__",
    ) if False else patch(
        "gocam_mega_editor.service.GoCamService.get_model",
        return_value=fake_model,
    ):
        resp = client.get("/model/568b0f9600000284")
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "Test pathway"
    assert data["taxon"] == "NCBITaxon:9606"
    assert len(data["activities"]) == 2


def test_get_graph(client):
    fake_model = _make_fake_model()
    with patch(
        "gocam_mega_editor.service.GoCamService.get_model",
        return_value=fake_model,
    ):
        resp = client.get("/graph?model_id=568b0f9600000284")
    assert resp.status_code == 200
    data = resp.json()
    assert data["model_count"] == 1
    assert data["node_count"] == 2
    assert data["edge_count"] == 1
    # Check node structure
    node_ids = {n["id"] for n in data["nodes"]}
    assert "UniProtKB:P12345" in node_ids
    assert "UniProtKB:P67890" in node_ids
    # Check edge structure
    edge = data["edges"][0]
    assert edge["source"] == "UniProtKB:P12345"
    assert edge["target"] == "UniProtKB:P67890"
    assert edge["causal_predicate"] == "RO:0002411"


def test_get_graph_multiple_models(client):
    model_a = _make_fake_model("model_a")
    model_b = _make_fake_model("model_b")

    call_count = 0

    def mock_get_model(model_id):
        nonlocal call_count
        call_count += 1
        return model_a if call_count == 1 else model_b

    with patch(
        "gocam_mega_editor.service.GoCamService.get_model",
        side_effect=mock_get_model,
    ):
        resp = client.get("/graph?model_id=model_a&model_id=model_b")
    assert resp.status_code == 200
    data = resp.json()
    assert data["model_count"] == 2


def test_graph_missing_model_ids(client):
    """graph endpoint requires at least one model_id."""
    resp = client.get("/graph")
    assert resp.status_code == 422
