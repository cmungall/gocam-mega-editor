import { useCallback, useMemo, useState } from "react"
import { useParams, useSearchParams } from "react-router-dom"
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type OnConnect,
  type NodeMouseHandler,
  type Connection,
  MarkerType,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Loader2 } from "lucide-react"

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
  type ProcessColor,
} from "@/lib/colors"
import { ActivityNode, type ActivityNodeData } from "./ActivityNode"
import { ActivityDetailPanel } from "./ActivityDetailPanel"
import { ActivityEditPanel } from "./ActivityEditPanel"
import { ModelHeader } from "./ModelHeader"
import type { NeighboringModelSummary } from "./NeighboringModelsSheet"
import { NewEdgeDialog } from "./NewEdgeDialog"
import { ProcessLegend } from "./ProcessLegend"

const nodeTypes = { activity: ActivityNode }

const LAYER_GAP = 360
const NODE_GAP = 72
const MODEL_GAP = 176
const MODEL_LABEL_HEIGHT = 50

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

interface PendingConnectionState {
  connection: Connection
  modelId: string
}

function shortModelId(value: string | GoCamModel): string {
  const raw = typeof value === "string" ? value : value.id
  return raw.replace(/^gomodel:/, "")
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
  selectedActivityId: string | null,
  expandedActivityId: string | null,
  xOffset: number,
  yOffset: number,
): { nodes: Node[]; height: number } {
  const idToIdx = new Map<string, number>()
  activities.forEach((activity, index) => idToIdx.set(activity.id, index))

  const layers: number[] = new Array(activities.length).fill(0)
  const visited = new Set<number>()

  function dfs(idx: number): number {
    if (visited.has(idx)) return layers[idx]
    visited.add(idx)
    const activity = activities[idx]
    let maxChild = -1
    for (const association of activity.causal_associations ?? []) {
      const childIdx = idToIdx.get(association.downstream_activity ?? "")
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
  const height = maxBottom - minTop

  const nodes = activities.map((activity, index) => {
    const layer = reversedLayers[index]
    const geneProduct = activity.enabled_by?.term ?? ""
    const bpTerm = activity.part_of?.term
    const color = getProcessColor(bpTerm, colorMap)
    const expanded = activity.id === expandedActivityId

    return {
      id: activity.id,
      type: "activity",
      selected: activity.id === selectedActivityId,
      position: {
        x: xOffset + layer * LAYER_GAP,
        y: yOffset + (positions.get(index) ?? 0) - minTop,
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
        connectedModelCount: geneConnCount.get(geneProduct) ?? 0,
        modelId: shortModelId(model),
      } satisfies ActivityNodeData,
    }
  })

  return { nodes, height }
}

function buildCausalEdges(activities: Activity[], model: GoCamModel): Edge[] {
  const edges: Edge[] = []
  for (const activity of activities) {
    for (const association of activity.causal_associations ?? []) {
      if (!association.downstream_activity) continue
      const predicateLabel = resolveLabel(association.predicate, model) || association.predicate || ""
      const edgeType = classifyPredicate(association.predicate)
      const edgeColor = EDGE_COLORS[edgeType]

      edges.push({
        id: `${activity.id}->${association.downstream_activity}`,
        source: activity.id,
        target: association.downstream_activity,
        label: predicateLabel,
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

export function GraphView() {
  const { modelId } = useParams<{ modelId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)
  const [expandedActivityId, setExpandedActivityId] = useState<string | null>(null)
  const [focusedModelId, setFocusedModelId] = useState<string | null>(modelId ?? null)
  const [editMode, setEditMode] = useState(false)
  const [pendingConnection, setPendingConnection] = useState<PendingConnectionState | null>(null)

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
  const focusedConnectionIndex = useMemo(() => {
    if (!activeFocusedModelId) return -1
    return workspaceModelIds.findIndex((workspaceId) => workspaceId === activeFocusedModelId)
  }, [activeFocusedModelId, workspaceModelIds])
  const neighboringModels = useMemo<NeighboringModelSummary[]>(() => {
    if (!activeFocusedModelId) return []
    const connections = workspaceConnections.get(activeFocusedModelId)
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

  const initialNodes = useMemo(() => {
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
    activeSelectedActivityId,
    activeExpandedActivityId,
  ])

  const initialEdges = useMemo(() => {
    const edges = workspaceModels.flatMap((workspaceModel) =>
      buildCausalEdges(workspaceModel.model.activities ?? [], workspaceModel.model)
    )
    edges.push(...buildSharedGeneEdges(workspaceModels))
    return edges
  }, [workspaceModels])

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
          neighboringModelsLoading={
            focusedConnectionIndex >= 0
              ? Boolean(workspaceConnectionQueries[focusedConnectionIndex]?.isLoading)
              : false
          }
          onImportModel={handleImportModel}
          onRemoveImportedModel={handleRemoveImportedModel}
        />

        <div className="flex-1 relative">
          <ReactFlow
            nodes={initialNodes}
            edges={initialEdges}
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

          {!selectedActivityEntry && workspaceModels.length === 1 && focusedConnectionSummary && focusedConnectionSummary.modelCount > 0 && (
            <div className="absolute left-14 top-2 z-10 max-w-sm rounded-lg border bg-card/95 px-3 py-2 shadow-sm backdrop-blur">
              <p className="text-[10px] font-medium text-foreground">
                {focusedConnectionSummary.geneCount} shared-gene connector{focusedConnectionSummary.geneCount === 1 ? "" : "s"} across {focusedConnectionSummary.modelCount} neighboring model{focusedConnectionSummary.modelCount === 1 ? "" : "s"}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Use the `Neighbors` button in the header, or click a node with an amber corner badge to inspect connected models and import them into this workspace.
              </p>
            </div>
          )}

          {editMode && (
            <div className="absolute bottom-2 left-14 z-10 bg-card/90 backdrop-blur border rounded px-2 py-1 max-w-sm">
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
