"""Tests for the FastAPI endpoints."""

from unittest.mock import patch

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
    with patch(
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
    node_ids = {n["id"] for n in data["nodes"]}
    assert "UniProtKB:P12345" in node_ids
    assert "UniProtKB:P67890" in node_ids
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


# --- CRUD tests ---


def test_update_activity_gene_product(client):
    """PATCH updates the enabled_by term on an activity."""
    fake = _make_fake_model()
    with patch("gocam_mega_editor.service.GoCamService.get_model", return_value=fake):
        resp = client.patch(
            "/model/568b0f9600000284/activity/activity_1",
            json={"enabled_by_term": "UniProtKB:Q99999"},
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["enabled_by"]["term"] == "UniProtKB:Q99999"


def test_update_activity_molecular_function(client):
    fake = _make_fake_model()
    with patch("gocam_mega_editor.service.GoCamService.get_model", return_value=fake):
        resp = client.patch(
            "/model/568b0f9600000284/activity/activity_2",
            json={
                "molecular_function_term": "GO:0004674",
                "evidence": [{"term": "ECO:0000314", "reference": "PMID:12345678"}],
            },
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["molecular_function"]["term"] == "GO:0004674"
    assert data["molecular_function"]["evidence"][0]["reference"] == "PMID:12345678"


def test_update_activity_not_found(client):
    fake = _make_fake_model()
    with patch("gocam_mega_editor.service.GoCamService.get_model", return_value=fake):
        resp = client.patch(
            "/model/568b0f9600000284/activity/nonexistent",
            json={"enabled_by_term": "UniProtKB:Q99999"},
        )
    assert resp.status_code == 404


def test_create_causal_edge(client):
    """POST creates a new causal association."""
    fake = _make_fake_model()
    # activity_2 starts with no causal_associations
    with patch("gocam_mega_editor.service.GoCamService.get_model", return_value=fake):
        resp = client.post(
            "/model/568b0f9600000284/causal-edge",
            json={
                "source_activity_id": "activity_2",
                "target_activity_id": "activity_1",
                "predicate": "RO:0002630",
            },
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["predicate"] == "RO:0002630"
    assert data["downstream_activity"] == "activity_1"
    # Verify it's actually on the model
    assert len(fake.activities[1].causal_associations) == 1


def test_create_causal_edge_target_not_found(client):
    fake = _make_fake_model()
    with patch("gocam_mega_editor.service.GoCamService.get_model", return_value=fake):
        resp = client.post(
            "/model/568b0f9600000284/causal-edge",
            json={
                "source_activity_id": "activity_1",
                "target_activity_id": "nonexistent",
                "predicate": "RO:0002629",
            },
        )
    assert resp.status_code == 404


def test_delete_causal_edge(client):
    fake = _make_fake_model()
    # activity_1 has a causal_association to activity_2
    assert len(fake.activities[0].causal_associations) == 1
    with patch("gocam_mega_editor.service.GoCamService.get_model", return_value=fake):
        resp = client.request(
            "DELETE",
            "/model/568b0f9600000284/causal-edge",
            params={
                "source_activity_id": "activity_1",
                "target_activity_id": "activity_2",
            },
        )
    assert resp.status_code == 200
    assert len(fake.activities[0].causal_associations) == 0


def test_list_predicates(client):
    resp = client.get("/predicates")
    assert resp.status_code == 200
    data = resp.json()
    assert "RO:0002629" in data
    assert data["RO:0002629"] == "directly positively regulates"
