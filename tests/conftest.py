"""Shared fixtures for tests."""

import pytest
from fastapi.testclient import TestClient

from gocam_mega_editor.adapters import MinervaAdapter
from gocam_mega_editor.app import app, service

FAKE_INDEX = [
    {
        "gocam": "http://model.geneontology.org/568b0f9600000284",
        "title": "Wnt signaling pathway",
        "taxon": "NCBITaxon:9606",
        "state": "production",
    },
    {
        "gocam": "http://model.geneontology.org/5a6a859200000953",
        "title": "Apoptosis signaling",
        "taxon": "NCBITaxon:10090",
        "state": "development",
    },
    {
        "gocam": "http://model.geneontology.org/testmodel003",
        "title": "Test pathway 3",
        "taxon": None,
        "state": None,
    },
]


@pytest.fixture
def client():
    """Test client with mocked index (no real HTTP calls for listing)."""
    adapter = service.adapter
    if isinstance(adapter, MinervaAdapter):
        adapter._index = FAKE_INDEX
        adapter._cache.clear()
    yield TestClient(app)
    if isinstance(adapter, MinervaAdapter):
        adapter._index = None
        adapter._cache.clear()


@pytest.fixture
def fake_index():
    return FAKE_INDEX
