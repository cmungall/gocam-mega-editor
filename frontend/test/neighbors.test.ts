import { describe, expect, it } from "vitest"

import type { ModelConnectionsResult } from "../src/lib/api"
import {
  buildNeighboringModelSummaries,
  filterNeighboringModels,
} from "../src/lib/neighbors"

const connections: ModelConnectionsResult = {
  model_id: "5b91dbd100002241",
  connections: [
    {
      gene_id: "UniProtKB:P12345",
      label: "sek-1",
      other_models: [
        {
          id: "5f46c3b700003884",
          title: "p38 MAPK signaling",
          taxon: "NCBITaxon:6239",
          status: null,
          date: null,
          contributors: [],
          groups: [],
          activity_count: 6,
        },
        {
          id: "57c82fad00000695",
          title: "Stress response",
          taxon: "NCBITaxon:6239",
          status: null,
          date: null,
          contributors: [],
          groups: [],
          activity_count: 3,
        },
      ],
    },
    {
      gene_id: "UniProtKB:Q99999",
      label: "pmk-1",
      other_models: [
        {
          id: "5f46c3b700003884",
          title: "p38 MAPK signaling",
          taxon: "NCBITaxon:6239",
          status: null,
          date: null,
          contributors: [],
          groups: [],
          activity_count: 6,
        },
      ],
    },
  ],
}

describe("buildNeighboringModelSummaries", () => {
  it("groups connections by neighboring model and sorts by shared gene count", () => {
    const summaries = buildNeighboringModelSummaries(connections)

    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({
      id: "5f46c3b700003884",
      title: "p38 MAPK signaling",
      activityCount: 6,
      sharedGeneCount: 2,
    })
    expect(summaries[0].sharedGenes).toEqual([
      { id: "UniProtKB:P12345", label: "sek-1" },
      { id: "UniProtKB:Q99999", label: "pmk-1" },
    ])
    expect(summaries[1]).toMatchObject({
      id: "57c82fad00000695",
      sharedGeneCount: 1,
    })
  })

  it("returns an empty list for missing connection data", () => {
    expect(buildNeighboringModelSummaries(null)).toEqual([])
    expect(buildNeighboringModelSummaries(undefined)).toEqual([])
  })
})

describe("filterNeighboringModels", () => {
  const summaries = buildNeighboringModelSummaries(connections)

  it("matches neighboring models by title, id, and shared gene label", () => {
    expect(filterNeighboringModels(summaries, "stress")).toHaveLength(1)
    expect(filterNeighboringModels(summaries, "5f46c3b700003884")).toHaveLength(1)
    expect(filterNeighboringModels(summaries, "pmk-1")).toHaveLength(1)
  })

  it("returns the original list for blank queries", () => {
    expect(filterNeighboringModels(summaries, "")).toEqual(summaries)
    expect(filterNeighboringModels(summaries, "   ")).toEqual(summaries)
  })
})
