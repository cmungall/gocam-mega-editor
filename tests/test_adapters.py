"""Tests for storage adapters."""

from pathlib import Path

import pytest
from gocam.datamodel import Activity, EnabledByGeneProductAssociation, Model

from gocam_mega_editor.adapters import InMemoryAdapter, MinervaAdapter, ModelAdapter


def _make_model(model_id: str = "test123", title: str = "Test model") -> Model:
    return Model(
        id=f"gomodel:{model_id}",
        title=title,
        activities=[
            Activity(
                id=f"gomodel:{model_id}/act1",
                enabled_by=EnabledByGeneProductAssociation(term="UniProtKB:P12345"),
            ),
        ],
    )


class TestInMemoryAdapter:
    def test_protocol_compliance(self):
        assert isinstance(InMemoryAdapter(), ModelAdapter)

    def test_empty(self):
        adapter = InMemoryAdapter()
        assert adapter.list_ids() == []
        assert adapter.get("nonexistent") is None

    def test_save_and_get(self):
        adapter = InMemoryAdapter()
        model = _make_model()
        adapter.save(model)
        assert "test123" in adapter.list_ids()
        retrieved = adapter.get("test123")
        assert retrieved is not None
        assert retrieved.title == "Test model"

    def test_list_summaries(self):
        adapter = InMemoryAdapter()
        adapter.save(_make_model("m1", "Model 1"))
        adapter.save(_make_model("m2", "Model 2"))
        summaries = adapter.list_summaries()
        assert len(summaries) == 2
        titles = {s["title"] for s in summaries}
        assert "Model 1" in titles
        assert "Model 2" in titles

    def test_list_summaries_pagination(self):
        adapter = InMemoryAdapter()
        for i in range(5):
            adapter.save(_make_model(f"m{i}", f"Model {i}"))
        page = adapter.list_summaries(limit=2, offset=1)
        assert len(page) == 2

    def test_delete(self):
        adapter = InMemoryAdapter()
        adapter.save(_make_model())
        assert adapter.delete("test123")
        assert adapter.get("test123") is None
        assert not adapter.delete("test123")  # already gone

    def test_overwrite(self):
        adapter = InMemoryAdapter()
        adapter.save(_make_model("x", "Original"))
        adapter.save(_make_model("x", "Updated"))
        assert adapter.get("x").title == "Updated"
        assert len(adapter.list_ids()) == 1


class TestInMemoryAdapterWithDisk:
    def test_persist_and_reload(self, tmp_path: Path):
        adapter = InMemoryAdapter(storage_dir=tmp_path)
        adapter.save(_make_model("disk1", "Persisted"))

        # File should exist
        files = list(tmp_path.glob("*.json"))
        assert len(files) == 1

        # New adapter loading from same dir
        adapter2 = InMemoryAdapter(storage_dir=tmp_path)
        assert "disk1" in adapter2.list_ids()
        assert adapter2.get("disk1").title == "Persisted"

    def test_delete_removes_file(self, tmp_path: Path):
        adapter = InMemoryAdapter(storage_dir=tmp_path)
        adapter.save(_make_model("del1"))
        assert len(list(tmp_path.glob("*.json"))) == 1
        adapter.delete("del1")
        assert len(list(tmp_path.glob("*.json"))) == 0


class TestMinervaAdapter:
    def test_protocol_compliance(self):
        assert isinstance(MinervaAdapter(), ModelAdapter)

    def test_save_to_cache(self):
        adapter = MinervaAdapter()
        model = _make_model("cached1")
        adapter.save(model)
        assert adapter.get("cached1").title == "Test model"

    def test_delete_from_cache(self):
        adapter = MinervaAdapter()
        adapter.save(_make_model("del1"))
        assert adapter.delete("del1")
        # get() would try to fetch from API, so just check delete return
        assert not adapter.delete("del1")
