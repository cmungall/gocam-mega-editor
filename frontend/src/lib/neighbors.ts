import type { ModelConnectionsResult } from "./api"

const CRITERION_ORDER = [
  "full_activity_signature",
  "terminal_to_initial",
  "chemical_flow",
  "gene_mf",
  "shared_chemical",
  "shared_gene",
]

export interface LinkCriterionSummary {
  type: string
  label: string
  count: number
  strength: string
}

export interface NeighboringModelSummary {
  id: string
  title: string
  activityCount: number
  sharedGeneCount: number
  sharedGenes: { id: string; label: string | null }[]
  linkScore: number
  linkCriteria: { type: string; label: string; count: number; strength: string }[]
  direction: "source_to_target" | "target_to_source" | "bidirectional" | "undirected"
}

export interface ActivityLinkSummary {
  modelCount: number
  criteria: LinkCriterionSummary[]
}

function criterionRank(type: string): number {
  const index = CRITERION_ORDER.indexOf(type)
  return index === -1 ? CRITERION_ORDER.length : index
}

function sortCriteria(criteria: LinkCriterionSummary[]): LinkCriterionSummary[] {
  return criteria.sort((left, right) => {
    const rankDiff = criterionRank(left.type) - criterionRank(right.type)
    if (rankDiff !== 0) return rankDiff
    if (right.count !== left.count) return right.count - left.count
    return left.label.localeCompare(right.label)
  })
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
      linkScore: number
      linkCriteria: { type: string; label: string; count: number; strength: string }[]
      direction: "source_to_target" | "target_to_source" | "bidirectional" | "undirected"
    }
  >()
  const linkedModels = new Map((connections.linked_models ?? []).map((model) => [model.id, model]))

  for (const connection of connections.connections) {
    for (const otherModel of connection.other_models) {
      const existing = byModel.get(otherModel.id) ?? {
        id: otherModel.id,
        title: otherModel.title,
        activityCount: otherModel.activity_count,
        sharedGenes: [],
        linkScore: 0,
        linkCriteria: [],
        direction: "undirected",
      }
      existing.sharedGenes.push({
        id: connection.gene_id,
        label: connection.label,
      })
      byModel.set(otherModel.id, existing)
    }
  }

  for (const link of connections.model_links ?? []) {
    const otherModelId = link.source === connections.model_id ? link.target : link.source
    const linkedModel = linkedModels.get(otherModelId)
    const existing = byModel.get(otherModelId) ?? {
      id: otherModelId,
      title: linkedModel?.title ?? otherModelId,
      activityCount: linkedModel?.activity_count ?? 0,
      sharedGenes: [],
      linkScore: 0,
      linkCriteria: [],
      direction: "undirected" as const,
    }
    existing.linkScore = Math.max(existing.linkScore, link.score ?? link.weight)
    existing.linkCriteria = (link.criteria ?? []).map((criterion) => ({
      type: criterion.type,
      label: criterion.label,
      count: criterion.count,
      strength: criterion.strength,
    }))
    existing.direction = link.direction ?? "undirected"
    if (!byModel.has(otherModelId)) {
      byModel.set(otherModelId, existing)
    }
  }

  return [...byModel.values()]
    .map((entry) => ({
      ...entry,
      sharedGeneCount: entry.sharedGenes.length,
    }))
    .sort((left, right) => {
      if (right.linkScore !== left.linkScore) {
        return right.linkScore - left.linkScore
      }
      if (right.sharedGeneCount !== left.sharedGeneCount) {
        return right.sharedGeneCount - left.sharedGeneCount
      }
      return left.title.localeCompare(right.title)
    })
}

export function summarizeNeighborCriteria(
  neighboringModels: NeighboringModelSummary[],
): LinkCriterionSummary[] {
  const byType = new Map<string, LinkCriterionSummary>()
  for (const neighbor of neighboringModels) {
    for (const criterion of neighbor.linkCriteria) {
      const existing = byType.get(criterion.type) ?? {
        type: criterion.type,
        label: criterion.label,
        count: 0,
        strength: criterion.strength,
      }
      existing.count += 1
      byType.set(criterion.type, existing)
    }
  }
  return sortCriteria([...byType.values()])
}

export function buildNeighborLinkCriteriaMap(
  connections?: ModelConnectionsResult | null,
): Map<string, LinkCriterionSummary[]> {
  const byModel = new Map<string, Map<string, LinkCriterionSummary>>()
  for (const link of connections?.model_links ?? []) {
    const otherModelId = link.source === connections?.model_id ? link.target : link.source
    const criteria = byModel.get(otherModelId) ?? new Map<string, LinkCriterionSummary>()
    for (const criterion of link.criteria ?? []) {
      const existing = criteria.get(criterion.type) ?? {
        type: criterion.type,
        label: criterion.label,
        count: 0,
        strength: criterion.strength,
      }
      existing.count += criterion.count
      criteria.set(criterion.type, existing)
    }
    byModel.set(otherModelId, criteria)
  }

  return new Map(
    [...byModel.entries()].map(([modelId, criteria]) => [
      modelId,
      sortCriteria([...criteria.values()]),
    ])
  )
}

export function buildActivityLinkSummaries(
  connections?: ModelConnectionsResult | null,
): Map<string, ActivityLinkSummary> {
  const byActivity = new Map<
    string,
    {
      modelIds: Set<string>
      criteria: Map<string, LinkCriterionSummary>
    }
  >()

  for (const link of connections?.model_links ?? []) {
    const currentIsSource = link.source === connections?.model_id
    const otherModelId = currentIsSource ? link.target : link.source
    for (const criterion of link.criteria ?? []) {
      for (const anchor of criterion.anchors ?? []) {
        const activityId = currentIsSource ? anchor.source_activity_id : anchor.target_activity_id
        if (!activityId) continue

        const existing = byActivity.get(activityId) ?? {
          modelIds: new Set<string>(),
          criteria: new Map<string, LinkCriterionSummary>(),
        }
        existing.modelIds.add(otherModelId)
        const criterionSummary = existing.criteria.get(criterion.type) ?? {
          type: criterion.type,
          label: criterion.label,
          count: 0,
          strength: criterion.strength,
        }
        criterionSummary.count += 1
        existing.criteria.set(criterion.type, criterionSummary)
        byActivity.set(activityId, existing)
      }
    }
  }

  return new Map(
    [...byActivity.entries()].map(([activityId, summary]) => [
      activityId,
      {
        modelCount: summary.modelIds.size,
        criteria: sortCriteria([...summary.criteria.values()]),
      },
    ])
  )
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
    if (neighbor.linkCriteria.some((criterion) => criterion.label.toLowerCase().includes(normalized))) return true
    return neighbor.sharedGenes.some((gene) => {
      const label = gene.label?.toLowerCase() ?? ""
      return label.includes(normalized) || gene.id.toLowerCase().includes(normalized)
    })
  })
}
