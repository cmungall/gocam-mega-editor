"""Ontology and gene product lookup service.

Field-aware autocomplete that routes queries to the right backend
(OLS for ontology terms, UniProt for gene products) with branch
constraints derived from the GO-CAM LinkML schema bindings.
"""

import logging
from dataclasses import dataclass, field
from enum import Enum

import requests

logger = logging.getLogger(__name__)

OLS_SELECT = "https://www.ebi.ac.uk/ols4/api/select"
UNIPROT_SEARCH = "https://rest.uniprot.org/uniprotkb/search"


class FieldType(str, Enum):
    """GO-CAM activity fields, each with specific autocomplete behavior."""

    enabled_by = "enabled_by"
    molecular_function = "molecular_function"
    biological_process = "biological_process"
    occurs_in = "occurs_in"
    evidence = "evidence"


# Branch constraints derived from gocam.yaml schema bindings.
# Each maps to the reachable_from source_node for the field's enum.
FIELD_CONSTRAINTS: dict[FieldType, dict] = {
    FieldType.molecular_function: {
        "ontology": "go",
        "root": "http://purl.obolibrary.org/obo/GO_0003674",
        "root_label": "molecular_function",
    },
    FieldType.biological_process: {
        "ontology": "go",
        "root": "http://purl.obolibrary.org/obo/GO_0008150",
        "root_label": "biological_process",
    },
    FieldType.occurs_in: {
        "ontology": "go",
        "root": "http://purl.obolibrary.org/obo/GO_0110165",
        "root_label": "cellular anatomical entity",
    },
    FieldType.evidence: {
        "ontology": "eco",
        "root": "http://purl.obolibrary.org/obo/ECO_0000000",
        "root_label": "evidence",
    },
}


@dataclass
class AutocompleteResult:
    id: str
    label: str
    category: str | None = None


@dataclass
class OntologyLookup:
    """Field-aware autocomplete service.

    Routes queries to OLS (ontology terms) or UniProt (gene products)
    based on the field type, applying branch constraints from the schema.

    >>> lookup = OntologyLookup()
    >>> results = lookup.search("molecular_function", "kinase")
    >>> all(r.id.startswith("GO:") for r in results)
    True
    """

    session: requests.Session = field(default_factory=requests.Session)

    def search(
        self,
        field_type: str,
        query: str,
        taxon: str | None = None,
        limit: int = 10,
    ) -> list[AutocompleteResult]:
        """Search for terms appropriate to the given field.

        Args:
            field_type: One of the FieldType values
            query: User's search text
            taxon: Optional taxon filter (for gene product search)
            limit: Max results

        Returns:
            List of matching terms with ID and label
        """
        if not query or len(query) < 2:
            return []

        ft = FieldType(field_type)

        if ft == FieldType.enabled_by:
            return self._search_gene_products(query, taxon=taxon, limit=limit)

        constraint = FIELD_CONSTRAINTS.get(ft)
        if constraint:
            return self._search_ols(
                query,
                ontology=constraint["ontology"],
                children_of=constraint["root"],
                limit=limit,
            )

        return []

    def _search_ols(
        self,
        query: str,
        ontology: str,
        children_of: str | None = None,
        limit: int = 10,
    ) -> list[AutocompleteResult]:
        """Search OLS4 with optional branch constraint."""
        params: dict = {
            "q": query,
            "ontology": ontology,
            "rows": limit,
            "fieldList": "obo_id,label,short_form,type",
        }
        if children_of:
            params["childrenOf"] = children_of

        resp = self.session.get(OLS_SELECT, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()

        results = []
        for doc in data.get("response", {}).get("docs", []):
            obo_id = doc.get("obo_id")
            label = doc.get("label")
            if obo_id and label:
                results.append(AutocompleteResult(
                    id=obo_id,
                    label=label,
                    category=ontology.upper(),
                ))
        return results

    def _search_gene_products(
        self,
        query: str,
        taxon: str | None = None,
        limit: int = 10,
    ) -> list[AutocompleteResult]:
        """Search UniProt for gene products, optionally filtered by taxon."""
        q_parts = [query]
        if taxon:
            # Extract NCBI taxon ID number
            taxon_id = taxon.replace("NCBITaxon:", "")
            q_parts.append(f"organism_id:{taxon_id}")

        params = {
            "query": " AND ".join(q_parts),
            "fields": "accession,gene_names,organism_name",
            "size": limit,
            "format": "json",
        }

        resp = self.session.get(UNIPROT_SEARCH, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()

        results = []
        for entry in data.get("results", []):
            acc = entry.get("primaryAccession", "")
            genes = entry.get("genes", [{}])
            gene_name = genes[0].get("geneName", {}).get("value", acc) if genes else acc
            org = entry.get("organism", {}).get("scientificName", "")
            label = f"{gene_name} ({org})" if org else gene_name
            results.append(AutocompleteResult(
                id=f"UniProtKB:{acc}",
                label=label,
                category="Gene Product",
            ))
        return results
