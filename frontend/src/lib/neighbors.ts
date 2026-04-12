import type { ModelConnectionsResult } from "./api"

export interface NeighboringModelSummary {
  id: string
  title: string
  activityCount: number
  sharedGeneCount: number
  sharedGenes: { id: string; label: string | null }[]
}

export function buildNeighboringModelSummaries(
  connections?: ModelConnectionsResult | null,
): NeighboringModelSummary[] {
  if (!connections) return []

  const byModel = new Map<
    string,
    {
      id: string
      title: string
      activityCount: number
      sharedGenes: { id: string; label: string | null }[]
    }
  >()

  for (const connection of connections.connections) {
    for (const otherModel of connection.other_models) {
      const existing = byModel.get(otherModel.id) ?? {
        id: otherModel.id,
        title: otherModel.title,
        activityCount: otherModel.activity_count,
        sharedGenes: [],
      }
      existing.sharedGenes.push({
        id: connection.gene_id,
        label: connection.label,
      })
      byModel.set(otherModel.id, existing)
    }
  }

  return [...byModel.values()]
    .map((entry) => ({
      ...entry,
      sharedGeneCount: entry.sharedGenes.length,
    }))
    .sort((left, right) => {
      if (right.sharedGeneCount !== left.sharedGeneCount) {
        return right.sharedGeneCount - left.sharedGeneCount
      }
      return left.title.localeCompare(right.title)
    })
}

export function filterNeighboringModels(
  neighboringModels: NeighboringModelSummary[],
  query: string,
): NeighboringModelSummary[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return neighboringModels

  return neighboringModels.filter((neighbor) => {
    if (neighbor.title.toLowerCase().includes(normalized)) return true
    if (neighbor.id.toLowerCase().includes(normalized)) return true
    return neighbor.sharedGenes.some((gene) => {
      const label = gene.label?.toLowerCase() ?? ""
      return label.includes(normalized) || gene.id.toLowerCase().includes(normalized)
    })
  })
}
