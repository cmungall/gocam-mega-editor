import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useSearchParams } from "react-router-dom"
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type OnConnect,
  type NodeMouseHandler,
  type Connection,
  MarkerType,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Loader2, RotateCcw } from "lucide-react"

import {
  fetchModel,
  fetchModelConnections,
  type GoCamModel,
  type Activity,
  type ModelConnectionsResult,
} from "@/lib/api"
import {
  buildProcessColorMap,
  getProcessColor,
  classifyPredicate,
  EDGE_COLORS,
  MOLECULE_FLOW_COLOR,
  type ProcessColor,
} from "@/lib/colors"
import {
  buildActivityLinkSummaries,
  buildNeighborLinkCriteriaMap,
  buildNeighboringModelSummaries,
  type ActivityLinkSummary,
  type NeighboringModelSummary,
} from "@/lib/neighbors"
import { ActivityNode, type ActivityNodeData } from "./ActivityNode"
import { ActivityDetailPanel } from "./ActivityDetailPanel"
import { ActivityEditPanel } from "./ActivityEditPanel"
import { MoleculeNode, type MoleculeNodeData } from "./MoleculeNode"
import { ModelHeader } from "./ModelHeader"
import { NewEdgeDialog } from "./NewEdgeDialog"
import { ProcessLegend } from "./ProcessLegend"
import { Button } from "@/components/ui/button"

const nodeTypes = { activity: ActivityNode, molecule: MoleculeNode }

const LAYER_GAP = 360
const NODE_GAP = 72
const MODEL_GAP = 176
const MODEL_LABEL_HEIGHT = 50
const MOLECULE_NODE_HEIGHT = 46
const MOLECULE_NODE_WIDTH = 176
const MOLECULE_GAP = 14
const HAS_INPUT = "RO:0002233"
const HAS_OUTPUT = "RO:0002234"

interface WorkspaceModelEntry {
  id: string
  model: GoCamModel
  imported: boolean
}

interface ActivityEntry {
  activity: Activity
  model: GoCamModel
  modelId: string
}

interface MoleculeFlowIndex {
  inputActivitiesByMolecule: Map<string, Set<string>>
  outputActivitiesByMolecule: Map<string, Set<string>>
  intermediateMoleculeIds: string[]
}

interface PendingConnectionState {
  connection: Connection
  modelId: string
}

function shortModelId(value: string | GoCamModel): string {
  const raw = typeof value === "string" ? value : value.id
  return raw.replace(/^gomodel:/, "")
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Unable to load neighboring models."
}

function resolveLabel(termId: string | undefined, model: GoCamModel): string {
  if (!termId) return ""
  const obj = model.objects?.find((o) => o.id === termId)
  return obj?.label ?? termId
}

function resolveLabelAcrossModels(termId: string | undefined, models: GoCamModel[]): string {
  if (!termId) return ""
  for (const model of models) {
    const label = resolveLabel(termId, model)
    if (label && label !== termId) {
      return label
    }
  }
  return termId
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string) {
  const values = map.get(key) ?? new Set<string>()
  values.add(value)
  map.set(key, values)
}

function moleculeNodeId(moleculeId: string): string {
  return `molecule:${moleculeId}`
}

function resolveMoleculeTerm(moleculeId: string, model: GoCamModel): string {
  const molecule = model.molecules?.find((candidate) => candidate.id === moleculeId)
  return molecule?.term ?? moleculeId
}

function resolveMoleculeLabel(moleculeId: string, model: GoCamModel): string {
  const term = resolveMoleculeTerm(moleculeId, model)
  return resolveLabel(term, model) || term
}

function resolveMoleculeLocation(moleculeId: string, model: GoCamModel): string {
  const molecule = model.molecules?.find((candidate) => candidate.id === moleculeId)
  return resolveLabel(molecule?.located_in?.term, model)
}

function buildMoleculeFlowIndex(model: GoCamModel, activities: Activity[]): MoleculeFlowIndex {
  const inputActivitiesByMolecule = new Map<string, Set<string>>()
  const outputActivitiesByMolecule = new Map<string, Set<string>>()

  for (const activity of activities) {
    for (const association of activity.molecular_associations ?? []) {
      if (!association.molecule) continue
      if (association.predicate === HAS_INPUT) {
        addToSetMap(inputActivitiesByMolecule, association.molecule, activity.id)
      } else if (association.predicate === HAS_OUTPUT) {
        addToSetMap(outputActivitiesByMolecule, association.molecule, activity.id)
      }
    }
  }

  const intermediateMoleculeIds = [...new Set([
    ...inputActivitiesByMolecule.keys(),
    ...outputActivitiesByMolecule.keys(),
  ])]
    .filter((moleculeId) =>
      Boolean(inputActivitiesByMolecule.get(moleculeId)?.size) &&
      Boolean(outputActivitiesByMolecule.get(moleculeId)?.size)
    )
    .sort((a, b) => resolveMoleculeLabel(a, model).localeCompare(resolveMoleculeLabel(b, model)))

  return {
    inputActivitiesByMolecule,
    outputActivitiesByMolecule,
    intermediateMoleculeIds,
  }
}

function buildActivityFlowAdjacency(
  activities: Activity[],
  moleculeFlow: MoleculeFlowIndex,
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()

  for (const activity of activities) {
    for (const association of activity.causal_associations ?? []) {
      if (!association.downstream_activity || association.downstream_activity === activity.id) continue
      addToSetMap(adjacency, activity.id, association.downstream_activity)
    }
  }

  for (const moleculeId of moleculeFlow.intermediateMoleculeIds) {
    const sources = moleculeFlow.outputActivitiesByMolecule.get(moleculeId) ?? new Set<string>()
    const targets = moleculeFlow.inputActivitiesByMolecule.get(moleculeId) ?? new Set<string>()
    for (const source of sources) {
      for (const target of targets) {
        if (source !== target) {
          addToSetMap(adjacency, source, target)
        }
      }
    }
  }

  return adjacency
}

function sortedActivityIds(activityIds: Set<string>, activityOrder: Map<string, number>): string[] {
  return [...activityIds].sort((a, b) => (activityOrder.get(a) ?? 0) - (activityOrder.get(b) ?? 0))
}

function estimateNodeHeight(activity: Activity, expanded: boolean): number {
  if (!expanded) return 78

  const detailCount = [
    activity.enabled_by?.term,
    activity.molecular_function?.term,
    activity.part_of?.term,
    activity.occurs_in?.term,
  ].filter(Boolean).length

  return 96 + detailCount * 18
}

function buildGeneConnectionCounts(connections?: ModelConnectionsResult | null): Map<string, number> {
  const counts = new Map<string, number>()
  for (const connection of connections?.connections ?? []) {
    counts.set(connection.gene_id, connection.other_models.length)
  }
  return counts
}

function buildWorkspaceLabelNode(
  entry: WorkspaceModelEntry,
  yOffset: number,
  focused: boolean,
): Node {
  const taxonLabel = resolveLabel(entry.model.taxon ?? undefined, entry.model)
  return {
    id: `workspace-label:${entry.id}`,
    position: { x: -260, y: yOffset },
    data: {
      label: (
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {entry.imported ? "Imported Model" : "Anchor Model"}
            {focused ? " · Focused" : ""}
          </span>
          <span className="text-xs font-semibold leading-tight">{entry.model.title}</span>
          <span className="text-[10px] text-muted-foreground">
            {shortModelId(entry.model)}
            {taxonLabel ? ` · ${taxonLabel}` : ""}
          </span>
        </div>
      ),
    },
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    style: {
      width: 248,
      borderRadius: "12px",
      border: focused ? "1px solid #0f172a" : "1px solid #d4d4d8",
      background: focused ? "#f8fafc" : "#ffffff",
      boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
      padding: "10px 12px",
      fontSize: "11px",
    },
  }
}

function layoutModelNodes(
  activities: Activity[],
  model: GoCamModel,
  colorMap: Map<string, ProcessColor>,
  geneConnCount: Map<string, number>,
  activityLinkSummary: Map<string, ActivityLinkSummary>,
  selectedActivityId: string | null,
  expandedActivityId: string | null,
  xOffset: number,
  yOffset: number,
): { nodes: Node[]; height: number } {
  if (activities.length === 0) return { nodes: [], height: 0 }

  type NodeSpec = { node: Node; localY: number; height: number }
  type ActivityLayout = { y: number; height: number; layer: number }

  const idToIdx = new Map<string, number>()
  activities.forEach((activity, index) => idToIdx.set(activity.id, index))
  const activityOrder = new Map(activities.map((activity, index) => [activity.id, index]))
  const moleculeFlow = buildMoleculeFlowIndex(model, activities)
  const activityFlowAdjacency = buildActivityFlowAdjacency(activities, moleculeFlow)

  const layers: number[] = new Array(activities.length).fill(0)
  const visited = new Set<number>()

  function dfs(idx: number): number {
    if (visited.has(idx)) return layers[idx]
    visited.add(idx)
    const activity = activities[idx]
    let maxChild = -1
    for (const childActivityId of activityFlowAdjacency.get(activity.id) ?? []) {
      const childIdx = idToIdx.get(childActivityId)
      if (childIdx !== undefined) {
        maxChild = Math.max(maxChild, dfs(childIdx))
      }
    }
    layers[idx] = maxChild + 1
    return layers[idx]
  }

  activities.forEach((_, index) => dfs(index))

  const maxLayer = Math.max(...layers, 0)
  const reversedLayers = layers.map((layer) => maxLayer - layer)
  const layerGroups = new Map<number, number[]>()
  reversedLayers.forEach((layer, index) => {
    const group = layerGroups.get(layer) ?? []
    group.push(index)
    layerGroups.set(layer, group)
  })

  const positions = new Map<number, number>()
  const heights = activities.map((activity) =>
    estimateNodeHeight(activity, activity.id === expandedActivityId)
  )

  for (const [, group] of layerGroups) {
    const groupHeights = group.map((idx) => heights[idx])
    const groupHeight =
      groupHeights.reduce((sum, height) => sum + height, 0) +
      NODE_GAP * Math.max(group.length - 1, 0)
    let cursor = -groupHeight / 2

    group.forEach((idx, groupIndex) => {
      positions.set(idx, cursor)
      cursor += groupHeights[groupIndex] + NODE_GAP
    })
  }

  const minTop = Math.min(...positions.values(), 0)
  const maxBottom = Math.max(...activities.map((_, index) => (positions.get(index) ?? 0) + heights[index]), 0)
  const activityLayouts = new Map<string, ActivityLayout>()

  const activitySpecs: NodeSpec[] = activities.map((activity, index) => {
    const layer = reversedLayers[index]
    const geneProduct = activity.enabled_by?.term ?? ""
    const bpTerm = activity.part_of?.term
    const color = getProcessColor(bpTerm, colorMap)
    const expanded = activity.id === expandedActivityId
    const linkSummary = activityLinkSummary.get(activity.id)
    const connectedModelCount = linkSummary?.modelCount ?? geneConnCount.get(geneProduct) ?? 0
    const localY = (positions.get(index) ?? 0) - minTop
    const x = xOffset + layer * LAYER_GAP
    activityLayouts.set(activity.id, {
      y: localY,
      height: heights[index],
      layer,
    })

    return {
      node: {
        id: activity.id,
        type: "activity",
        selected: activity.id === selectedActivityId,
        position: {
          x,
          y: localY,
        },
        data: {
          label: resolveLabel(geneProduct, model),
          geneProduct,
          molecularFunction: resolveLabel(activity.molecular_function?.term, model),
          biologicalProcess: resolveLabel(bpTerm, model),
          cellularComponent: resolveLabel(activity.occurs_in?.term, model),
          isExpanded: expanded,
          bgColor: color.bg,
          borderColor: color.border,
          textColor: color.text,
          connectedModelCount,
          connectionCriteriaLabels: linkSummary?.criteria.map((criterion) => criterion.label),
          modelId: shortModelId(model),
        } satisfies ActivityNodeData,
      },
      localY,
      height: heights[index],
    }
  })

  const moleculeSpecs: NodeSpec[] = []
  const placedMolecules: { x: number; y: number }[] = []
  for (const moleculeId of moleculeFlow.intermediateMoleculeIds) {
    const producerLayouts = sortedActivityIds(
      moleculeFlow.outputActivitiesByMolecule.get(moleculeId) ?? new Set<string>(),
      activityOrder,
    )
      .map((activityId) => activityLayouts.get(activityId))
      .filter((layout): layout is ActivityLayout => Boolean(layout))
    const consumerLayouts = sortedActivityIds(
      moleculeFlow.inputActivitiesByMolecule.get(moleculeId) ?? new Set<string>(),
      activityOrder,
    )
      .map((activityId) => activityLayouts.get(activityId))
      .filter((layout): layout is ActivityLayout => Boolean(layout))

    if (producerLayouts.length === 0 || consumerLayouts.length === 0) continue

    const averageProducerLayer =
      producerLayouts.reduce((sum, layout) => sum + layout.layer, 0) / producerLayouts.length
    const averageConsumerLayer =
      consumerLayouts.reduce((sum, layout) => sum + layout.layer, 0) / consumerLayouts.length
    const moleculeLayer =
      averageConsumerLayer > averageProducerLayer
        ? (averageProducerLayer + averageConsumerLayer) / 2
        : averageProducerLayer + 0.5
    const connectedLayouts = [...producerLayouts, ...consumerLayouts]
    const averageCenterY =
      connectedLayouts.reduce((sum, layout) => sum + layout.y + layout.height / 2, 0) /
      connectedLayouts.length
    const x = xOffset + moleculeLayer * LAYER_GAP
    let localY = averageCenterY - MOLECULE_NODE_HEIGHT / 2

    while (
      placedMolecules.some(
        (placed) =>
          Math.abs(placed.x - x) < MOLECULE_NODE_WIDTH &&
          localY < placed.y + MOLECULE_NODE_HEIGHT + MOLECULE_GAP &&
          localY + MOLECULE_NODE_HEIGHT + MOLECULE_GAP > placed.y,
      )
    ) {
      localY += MOLECULE_NODE_HEIGHT + MOLECULE_GAP
    }
    placedMolecules.push({ x, y: localY })

    const term = resolveMoleculeTerm(moleculeId, model)
    moleculeSpecs.push({
      node: {
        id: moleculeNodeId(moleculeId),
        type: "molecule",
        position: { x, y: localY },
        draggable: true,
        selectable: false,
        connectable: false,
        focusable: false,
        data: {
          label: resolveMoleculeLabel(moleculeId, model),
          term,
          location: resolveMoleculeLocation(moleculeId, model),
          modelId: shortModelId(model),
          borderColor: MOLECULE_FLOW_COLOR.border,
        } satisfies MoleculeNodeData,
      },
      localY,
      height: MOLECULE_NODE_HEIGHT,
    })
  }

  const specs = [...activitySpecs, ...moleculeSpecs]
  const minTopAll = Math.min(...specs.map((spec) => spec.localY), 0)
  const maxBottomAll = Math.max(...specs.map((spec) => spec.localY + spec.height), maxBottom - minTop)
  const nodes = specs.map((spec) => ({
    ...spec.node,
    position: {
      ...spec.node.position,
      y: yOffset + spec.localY - minTopAll,
    },
  }))

  return { nodes, height: maxBottomAll - minTopAll }
}

function buildCausalEdges(activities: Activity[], model: GoCamModel): Edge[] {
  const edges: Edge[] = []
  const seen = new Set<string>()
  for (const activity of activities) {
    for (const association of activity.causal_associations ?? []) {
      if (!association.downstream_activity) continue
      const edgeId = `causal:${activity.id}:${association.downstream_activity}:${association.predicate ?? ""}`
      if (seen.has(edgeId)) continue
      seen.add(edgeId)
      const predicateLabel = resolveLabel(association.predicate, model) || association.predicate || ""
      const edgeType = classifyPredicate(association.predicate)
      const edgeColor = EDGE_COLORS[edgeType]

      edges.push({
        id: edgeId,
        source: activity.id,
        target: association.downstream_activity,
        label: predicateLabel,
        zIndex: 2,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: edgeColor.stroke,
        },
        style: {
          strokeWidth: 2,
          stroke: edgeColor.stroke,
        },
        labelStyle: {
          fontSize: 9,
          fontWeight: 500,
          fill: edgeColor.label,
        },
        labelBgStyle: {
          fill: "#ffffff",
          fillOpacity: 0.85,
        },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
      })
    }
  }
  return edges
}

function buildMoleculeFlowEdges(activities: Activity[], model: GoCamModel): Edge[] {
  const moleculeFlow = buildMoleculeFlowIndex(model, activities)
  const activityOrder = new Map(activities.map((activity, index) => [activity.id, index]))
  const edges: Edge[] = []
  const seen = new Set<string>()

  function addMoleculeEdge(id: string, source: string, target: string) {
    if (seen.has(id)) return
    seen.add(id)
    edges.push({
      id,
      source,
      target,
      type: "smoothstep",
      selectable: false,
      zIndex: 1,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 12,
        height: 12,
        color: MOLECULE_FLOW_COLOR.stroke,
      },
      style: {
        strokeWidth: 1.6,
        stroke: MOLECULE_FLOW_COLOR.stroke,
        strokeDasharray: "4 3",
        opacity: 0.85,
      },
    })
  }

  for (const moleculeId of moleculeFlow.intermediateMoleculeIds) {
    const moleculeNode = moleculeNodeId(moleculeId)
    const producers = sortedActivityIds(
      moleculeFlow.outputActivitiesByMolecule.get(moleculeId) ?? new Set<string>(),
      activityOrder,
    )
    const consumers = sortedActivityIds(
      moleculeFlow.inputActivitiesByMolecule.get(moleculeId) ?? new Set<string>(),
      activityOrder,
    )

    for (const producer of producers) {
      addMoleculeEdge(`molecule-output:${producer}:${moleculeNode}`, producer, moleculeNode)
    }
    for (const consumer of consumers) {
      addMoleculeEdge(`molecule-input:${moleculeNode}:${consumer}`, moleculeNode, consumer)
    }
  }

  return edges
}

function buildSharedGeneEdges(entries: WorkspaceModelEntry[]): Edge[] {
  const workspaceOrder = new Map(entries.map((entry, index) => [entry.id, index]))
  const geneOccurrences = new Map<
    string,
    { activityId: string; modelId: string; label: string; workspaceIndex: number }[]
  >()

  for (const entry of entries) {
    const seenGenes = new Set<string>()
    for (const activity of entry.model.activities ?? []) {
      const gene = activity.enabled_by?.term
      if (!gene || seenGenes.has(gene)) continue
      seenGenes.add(gene)
      const occurrences = geneOccurrences.get(gene) ?? []
      occurrences.push({
        activityId: activity.id,
        modelId: entry.id,
        label: resolveLabel(gene, entry.model),
        workspaceIndex: workspaceOrder.get(entry.id) ?? 0,
      })
      geneOccurrences.set(gene, occurrences)
    }
  }

  const edges: Edge[] = []
  for (const [gene, occurrences] of geneOccurrences) {
    if (occurrences.length < 2) continue
    const sorted = occurrences.slice().sort((a, b) => a.workspaceIndex - b.workspaceIndex)
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const source = sorted[index]
      const target = sorted[index + 1]
      edges.push({
        id: `shared:${gene}:${source.activityId}:${target.activityId}`,
        source: source.activityId,
        target: target.activityId,
        type: "straight",
        label: sorted.length === 2 ? source.label : undefined,
        animated: true,
        selectable: false,
        style: {
          stroke: "#f59e0b",
          strokeWidth: 1.5,
          strokeDasharray: "6 4",
          opacity: 0.65,
        },
        labelStyle: {
          fontSize: 8,
          fontWeight: 600,
          fill: "#92400e",
        },
        labelBgStyle: {
          fill: "#fff7ed",
          fillOpacity: 0.92,
        },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
      })
    }
  }

  return edges
}

function activityPanelKey(activity: Activity): string {
  return JSON.stringify(activity)
}

function nodeDataSignature(node: Node): string {
  const data = node.data as Record<string, unknown> | undefined
  if (!data) return ""
  return [
    typeof data.label === "string" ? data.label : "",
    data.geneProduct,
    data.molecularFunction,
    data.biologicalProcess,
    data.cellularComponent,
    data.isExpanded,
    data.connectedModelCount,
    Array.isArray(data.connectionCriteriaLabels) ? data.connectionCriteriaLabels.join(",") : "",
    data.modelId,
    data.bgColor,
    data.borderColor,
    data.textColor,
    data.term,
    data.location,
  ].join("|")
}

function nodeRenderSignature(nodes: Node[]): string {
  return nodes
    .map((node) =>
      [
        node.id,
        node.type,
        node.selected,
        node.draggable,
        node.selectable,
        node.connectable,
        Math.round(node.position.x),
        Math.round(node.position.y),
        JSON.stringify(node.style ?? {}),
        nodeDataSignature(node),
      ].join("~")
    )
    .join("\n")
}

function edgeRenderSignature(edges: Edge[]): string {
  return edges
    .map((edge) =>
      [
        edge.id,
        edge.source,
        edge.target,
        edge.type,
        edge.label,
        edge.animated,
        JSON.stringify(edge.markerStart ?? {}),
        JSON.stringify(edge.markerEnd ?? {}),
        JSON.stringify(edge.style ?? {}),
      ].join("~")
    )
    .join("\n")
}

export function GraphView() {
  const { modelId } = useParams<{ modelId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)
  const [expandedActivityId, setExpandedActivityId] = useState<string | null>(null)
  const [focusedModelId, setFocusedModelId] = useState<string | null>(modelId ?? null)
  const [editMode, setEditMode] = useState(false)
  const [pendingConnection, setPendingConnection] = useState<PendingConnectionState | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const lastAppliedNodeSignature = useRef("")
  const lastAppliedEdgeSignature = useRef("")

  const importedModelIds = useMemo(() => {
    const raw = searchParams.get("import")
    if (!raw) return []
    const seen = new Set<string>()
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value !== modelId)
      .filter((value) => {
        if (seen.has(value)) return false
        seen.add(value)
        return true
      })
  }, [searchParams, modelId])

  const { data: anchorModel, isLoading: anchorLoading } = useQuery({
    queryKey: ["model", modelId],
    queryFn: () => fetchModel(modelId!),
    enabled: Boolean(modelId),
  })

  const importedModelQueries = useQueries({
    queries: importedModelIds.map((importedId) => ({
      queryKey: ["model", importedId],
      queryFn: () => fetchModel(importedId),
      enabled: Boolean(importedId),
    })),
  })

  const workspaceModels = useMemo(() => {
    if (!anchorModel || !modelId) return []
    const entries: WorkspaceModelEntry[] = [
      { id: modelId, model: anchorModel, imported: false },
    ]
    importedModelQueries.forEach((result, index) => {
      if (result.data) {
        entries.push({
          id: importedModelIds[index],
          model: result.data,
          imported: true,
        })
      }
    })
    return entries
  }, [anchorModel, importedModelIds, importedModelQueries, modelId])

  const workspaceModelIds = useMemo(
    () => workspaceModels.map((entry) => entry.id),
    [workspaceModels]
  )

  const workspaceLookup = useMemo(
    () => new Map(workspaceModels.map((entry) => [entry.id, entry.model])),
    [workspaceModels]
  )
  const workspaceConnectionQueries = useQueries({
    queries: workspaceModelIds.map((workspaceId) => ({
      queryKey: ["connections", workspaceId],
      queryFn: () => fetchModelConnections(workspaceId),
      enabled: Boolean(workspaceId),
    })),
  })

  const activityEntries = useMemo(() => {
    const entries = new Map<string, ActivityEntry>()
    for (const workspaceModel of workspaceModels) {
      for (const activity of workspaceModel.model.activities ?? []) {
        entries.set(activity.id, {
          activity,
          model: workspaceModel.model,
          modelId: workspaceModel.id,
        })
      }
    }
    return entries
  }, [workspaceModels])

  const activeSelectedActivityId =
    selectedActivityId && activityEntries.has(selectedActivityId) ? selectedActivityId : null
  const activeExpandedActivityId =
    expandedActivityId && activityEntries.has(expandedActivityId)
      ? expandedActivityId
      : activeSelectedActivityId
  const activeFocusedModelId =
    focusedModelId && workspaceLookup.has(focusedModelId) ? focusedModelId : (modelId ?? null)
  const activePendingConnection = useMemo(() => {
    if (!pendingConnection) return null
    if (!workspaceLookup.has(pendingConnection.modelId)) return null

    const sourceId = pendingConnection.connection.source
    const targetId = pendingConnection.connection.target
    if (!sourceId || !targetId) return null

    const sourceEntry = activityEntries.get(sourceId)
    const targetEntry = activityEntries.get(targetId)
    if (!sourceEntry || !targetEntry) return null
    if (
      sourceEntry.modelId !== pendingConnection.modelId ||
      targetEntry.modelId !== pendingConnection.modelId
    ) {
      return null
    }

    return pendingConnection
  }, [activityEntries, pendingConnection, workspaceLookup])

  const selectedActivityEntry = activeSelectedActivityId
    ? activityEntries.get(activeSelectedActivityId) ?? null
    : null
  const focusedModel = (activeFocusedModelId && workspaceLookup.get(activeFocusedModelId)) ?? anchorModel ?? null
  const workspaceConnections = useMemo(
    () =>
      new Map(
        workspaceModelIds.map((workspaceId, index) => [
          workspaceId,
          workspaceConnectionQueries[index]?.data ?? null,
        ])
      ),
    [workspaceConnectionQueries, workspaceModelIds]
  )
  const geneConnCountsByModel = useMemo(
    () =>
      new Map(
        workspaceModelIds.map((workspaceId) => [
          workspaceId,
          buildGeneConnectionCounts(workspaceConnections.get(workspaceId)),
        ])
      ),
    [workspaceConnections, workspaceModelIds]
  )
  const activityLinkSummariesByModel = useMemo(
    () =>
      new Map(
        workspaceModelIds.map((workspaceId) => [
          workspaceId,
          buildActivityLinkSummaries(workspaceConnections.get(workspaceId)),
        ])
      ),
    [workspaceConnections, workspaceModelIds]
  )
  const focusedConnectionIndex = useMemo(() => {
    if (!activeFocusedModelId) return -1
    return workspaceModelIds.findIndex((workspaceId) => workspaceId === activeFocusedModelId)
  }, [activeFocusedModelId, workspaceModelIds])
  const focusedConnectionQuery =
    focusedConnectionIndex >= 0 ? workspaceConnectionQueries[focusedConnectionIndex] : undefined
  const focusedConnectionError =
    focusedConnectionQuery?.isError ? formatErrorMessage(focusedConnectionQuery.error) : null
  const neighboringModels = useMemo<NeighboringModelSummary[]>(() => {
    if (!activeFocusedModelId) return []
    return buildNeighboringModelSummaries(workspaceConnections.get(activeFocusedModelId))
  }, [activeFocusedModelId, workspaceConnections])
  const focusedConnectionSummary = useMemo(() => {
    if (!activeFocusedModelId) return null
    const connections = workspaceConnections.get(activeFocusedModelId)
    if (!connections) return null

    const neighboringModelIds = new Set<string>()
    for (const connection of connections.connections) {
      for (const model of connection.other_models) {
        neighboringModelIds.add(model.id)
      }
    }

    return {
      geneCount: connections.connections.length,
      modelCount: neighboringModelIds.size,
    }
  }, [activeFocusedModelId, workspaceConnections])

  const { colorMap, processLabels } = useMemo(() => {
    const models = workspaceModels.map((entry) => entry.model)
    const bpTerms = models.flatMap((workspaceModel) =>
      (workspaceModel.activities ?? []).map((activity) => activity.part_of?.term)
    )
    const nextColorMap = buildProcessColorMap(bpTerms)
    const labels = new Map<string, string>()
    for (const termId of nextColorMap.keys()) {
      labels.set(termId, resolveLabelAcrossModels(termId, models))
    }
    return { colorMap: nextColorMap, processLabels: labels }
  }, [workspaceModels])

  const computedNodes = useMemo(() => {
    if (workspaceModels.length === 0) return []

    const nodes: Node[] = []
    let laneOffset = 0

    for (const workspaceModel of workspaceModels) {
      nodes.push(
        buildWorkspaceLabelNode(
          workspaceModel,
          laneOffset,
          workspaceModel.id === activeFocusedModelId,
        )
      )

      const lane = layoutModelNodes(
        workspaceModel.model.activities ?? [],
        workspaceModel.model,
        colorMap,
        geneConnCountsByModel.get(workspaceModel.id) ?? new Map<string, number>(),
        activityLinkSummariesByModel.get(workspaceModel.id) ?? new Map<string, ActivityLinkSummary>(),
        activeSelectedActivityId,
        activeExpandedActivityId,
        0,
        laneOffset + MODEL_LABEL_HEIGHT + 18,
      )
      nodes.push(...lane.nodes)
      laneOffset += MODEL_LABEL_HEIGHT + 18 + lane.height + MODEL_GAP
    }

    return nodes
  }, [
    workspaceModels,
    activeFocusedModelId,
    colorMap,
    geneConnCountsByModel,
    activityLinkSummariesByModel,
    activeSelectedActivityId,
    activeExpandedActivityId,
  ])

  const computedEdges = useMemo(() => {
    const edges = workspaceModels.flatMap((workspaceModel) => {
      const activities = workspaceModel.model.activities ?? []
      return [
        ...buildMoleculeFlowEdges(activities, workspaceModel.model),
        ...buildCausalEdges(activities, workspaceModel.model),
      ]
    })
    edges.push(...buildSharedGeneEdges(workspaceModels))
    return edges
  }, [workspaceModels])
  const computedNodeSignature = useMemo(() => nodeRenderSignature(computedNodes), [computedNodes])
  const computedEdgeSignature = useMemo(() => edgeRenderSignature(computedEdges), [computedEdges])

  useEffect(() => {
    if (lastAppliedNodeSignature.current === computedNodeSignature) return
    lastAppliedNodeSignature.current = computedNodeSignature
    setNodes((currentNodes) => {
      const currentById = new Map(currentNodes.map((node) => [node.id, node]))
      return computedNodes.map((node) => {
        const current = currentById.get(node.id)
        if (!current) return node
        return {
          ...node,
          position: current.position,
        }
      })
    })
  }, [computedNodeSignature, computedNodes, setNodes])

  useEffect(() => {
    if (lastAppliedEdgeSignature.current === computedEdgeSignature) return
    lastAppliedEdgeSignature.current = computedEdgeSignature
    setEdges(computedEdges)
  }, [computedEdgeSignature, computedEdges, setEdges])

  const resetLayout = useCallback(() => {
    lastAppliedNodeSignature.current = computedNodeSignature
    lastAppliedEdgeSignature.current = computedEdgeSignature
    setNodes(computedNodes)
    setEdges(computedEdges)
  }, [computedEdgeSignature, computedEdges, computedNodeSignature, computedNodes, setEdges, setNodes])

  const updateImportedModels = useCallback(
    (nextImportedIds: string[]) => {
      const nextSearchParams = new URLSearchParams(searchParams)
      if (nextImportedIds.length > 0) {
        nextSearchParams.set("import", nextImportedIds.join(","))
      } else {
        nextSearchParams.delete("import")
      }
      setSearchParams(nextSearchParams)
    },
    [searchParams, setSearchParams]
  )

  const handleImportModel = useCallback(
    (nextModelId: string) => {
      if (!modelId || nextModelId === modelId) {
        setFocusedModelId(modelId ?? null)
        return
      }
      if (importedModelIds.includes(nextModelId)) {
        setFocusedModelId(nextModelId)
        return
      }
      setFocusedModelId(nextModelId)
      updateImportedModels([...importedModelIds, nextModelId])
    },
    [importedModelIds, modelId, updateImportedModels]
  )

  const handleRemoveImportedModel = useCallback(
    (removeModelId: string) => {
      updateImportedModels(importedModelIds.filter((id) => id !== removeModelId))
      if (selectedActivityEntry?.modelId === removeModelId) {
        setSelectedActivityId(null)
        setExpandedActivityId(null)
      }
      if (activePendingConnection?.modelId === removeModelId) {
        setPendingConnection(null)
      }
      if (activeFocusedModelId === removeModelId) {
        setFocusedModelId(modelId ?? null)
      }
    },
    [
      activeFocusedModelId,
      activePendingConnection?.modelId,
      importedModelIds,
      modelId,
      selectedActivityEntry?.modelId,
      updateImportedModels,
    ]
  )

  const handleFocusModel = useCallback(
    (nextModelId: string) => {
      setFocusedModelId(nextModelId)
      if (selectedActivityEntry?.modelId !== nextModelId) {
        setSelectedActivityId(null)
        setExpandedActivityId(null)
      }
    },
    [selectedActivityEntry?.modelId]
  )

  const handleSelectConnectorGene = useCallback(
    (geneId: string) => {
      if (!activeFocusedModelId) return
      const focusedEntry = workspaceModels.find((entry) => entry.id === activeFocusedModelId)
      if (!focusedEntry) return

      const matchingActivity = (focusedEntry.model.activities ?? []).find(
        (activity) => activity.enabled_by?.term === geneId
      )
      if (!matchingActivity) return

      setFocusedModelId(focusedEntry.id)
      setSelectedActivityId(matchingActivity.id)
      setExpandedActivityId(matchingActivity.id)
    },
    [activeFocusedModelId, workspaceModels]
  )

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.type !== "activity") return
      const nextId = activeSelectedActivityId === node.id ? null : node.id
      if (!nextId) {
        setSelectedActivityId(null)
        setExpandedActivityId(null)
        return
      }

      const entry = activityEntries.get(nextId)
      setSelectedActivityId(nextId)
      setExpandedActivityId(nextId)
      if (entry) {
        setFocusedModelId(entry.modelId)
      }
    },
    [activityEntries, activeSelectedActivityId]
  )

  const onConnect: OnConnect = useCallback(
    (connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return
      const sourceEntry = activityEntries.get(connection.source)
      const targetEntry = activityEntries.get(connection.target)
      if (!sourceEntry || !targetEntry || sourceEntry.modelId !== targetEntry.modelId) {
        return
      }
      setFocusedModelId(sourceEntry.modelId)
      setPendingConnection({
        connection,
        modelId: sourceEntry.modelId,
      })
    },
    [activityEntries]
  )

  function handleEdgeCreated() {
    if (!activePendingConnection) return
    queryClient.invalidateQueries({ queryKey: ["model", activePendingConnection.modelId] })
    queryClient.invalidateQueries({ queryKey: ["changes", activePendingConnection.modelId] })
    queryClient.invalidateQueries({ queryKey: ["connections", activePendingConnection.modelId] })
    setPendingConnection(null)
    setSelectedActivityId(null)
    setExpandedActivityId(null)
  }

  if (anchorLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!anchorModel || !modelId || !focusedModel) {
    return <div className="p-8 text-destructive">Model not found</div>
  }

  const selectedGeneConnection = selectedActivityEntry
    ? workspaceConnections
        .get(selectedActivityEntry.modelId)
        ?.connections.find((connection) => connection.gene_id === selectedActivityEntry.activity.enabled_by?.term)
    : undefined
  const selectedNeighborLinkCriteriaByModel = selectedActivityEntry
    ? buildNeighborLinkCriteriaMap(workspaceConnections.get(selectedActivityEntry.modelId))
    : undefined

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col">
        <ModelHeader
          model={focusedModel}
          editMode={editMode}
          onToggleEdit={() => setEditMode(!editMode)}
          workspaceModels={workspaceModels.map((entry) => entry.model)}
          anchorModelId={modelId}
          focusedModelId={activeFocusedModelId ?? modelId}
          onFocusModel={handleFocusModel}
          neighboringModels={neighboringModels}
          neighboringModelsLoading={Boolean(focusedConnectionQuery?.isLoading)}
          neighboringModelsError={focusedConnectionError}
          onImportModel={handleImportModel}
          onSelectConnectorGene={handleSelectConnectorGene}
          onRemoveImportedModel={handleRemoveImportedModel}
        />

        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onConnect={editMode ? onConnect : undefined}
            nodeTypes={nodeTypes}
            nodesConnectable={editMode}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.1}
            maxZoom={4}
            connectOnClick={editMode}
          >
            <Background gap={20} size={1} />
            <Controls />
            <MiniMap
              nodeStrokeWidth={3}
              className="!bg-muted/80"
              nodeColor={(node) => {
                const data = node.data as ActivityNodeData
                return data?.borderColor ?? "#d4d4d8"
              }}
            />
          </ReactFlow>

          <ProcessLegend processColors={colorMap} processLabels={processLabels} />

          <div className="absolute bottom-2 left-14 z-10 flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 bg-card/90 text-[10px] shadow-sm backdrop-blur"
              onClick={resetLayout}
              title="Reset layout"
            >
              <RotateCcw className="h-3 w-3" />
              Reset layout
            </Button>
          </div>

          {!selectedActivityEntry && workspaceModels.length === 1 && focusedConnectionSummary && focusedConnectionSummary.modelCount > 0 && (
            <div className="absolute left-14 top-2 z-10 max-w-sm rounded-lg border bg-card/95 px-3 py-2 shadow-sm backdrop-blur">
              <p className="text-[10px] font-medium text-foreground">
                {focusedConnectionSummary.geneCount} shared-gene connector{focusedConnectionSummary.geneCount === 1 ? "" : "s"} and other model-link criteria across {focusedConnectionSummary.modelCount} neighboring model{focusedConnectionSummary.modelCount === 1 ? "" : "s"}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Use the `Neighbors` button in the header, or click a node with an amber corner badge to inspect connected models and import them into this workspace.
              </p>
            </div>
          )}

          {editMode && (
            <div className="absolute bottom-11 left-14 z-10 bg-card/90 backdrop-blur border rounded px-2 py-1 max-w-sm">
              <p className="text-[10px] text-muted-foreground">
                Drag from one node handle to another to create a causal edge. Imported models share the same canvas, but edges can only be created within a single model lane.
              </p>
            </div>
          )}
        </div>
      </div>

      {selectedActivityEntry && (
        editMode ? (
          <ActivityEditPanel
            key={activityPanelKey(selectedActivityEntry.activity)}
            activity={selectedActivityEntry.activity}
            model={selectedActivityEntry.model}
            onClose={() => {
              setSelectedActivityId(null)
              setExpandedActivityId(null)
            }}
            onSaved={() => {}}
          />
        ) : (
          <ActivityDetailPanel
            activity={selectedActivityEntry.activity}
            model={selectedActivityEntry.model}
            onEdit={() => {
              setFocusedModelId(selectedActivityEntry.modelId)
              setEditMode(true)
            }}
            onClose={() => {
              setSelectedActivityId(null)
              setExpandedActivityId(null)
            }}
            geneConnection={selectedGeneConnection}
            neighborLinkCriteriaByModel={selectedNeighborLinkCriteriaByModel}
            workspaceModelIds={workspaceModelIds}
            focusedModelId={activeFocusedModelId ?? modelId}
            onImportModel={handleImportModel}
            onFocusModel={handleFocusModel}
          />
        )
      )}

      {activePendingConnection && focusedModel && (
        <NewEdgeDialog
          open
          sourceActivityId={activePendingConnection.connection.source!}
          targetActivityId={activePendingConnection.connection.target!}
          model={workspaceLookup.get(activePendingConnection.modelId) ?? focusedModel}
          onClose={() => setPendingConnection(null)}
          onCreated={handleEdgeCreated}
        />
      )}
    </div>
  )
}
