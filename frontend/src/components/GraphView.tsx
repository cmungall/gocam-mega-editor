import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, Link } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type NodeMouseHandler,
  type Connection,
  MarkerType,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { ArrowLeft, Loader2, Pencil } from "lucide-react"

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
import { Button } from "@/components/ui/button"
import { ActivityNode, type ActivityNodeData } from "./ActivityNode"
import { ActivityDetailPanel } from "./ActivityDetailPanel"
import { ActivityEditPanel } from "./ActivityEditPanel"
import { NewEdgeDialog } from "./NewEdgeDialog"
import { ProcessLegend } from "./ProcessLegend"

const nodeTypes = { activity: ActivityNode }

function resolveLabel(termId: string | undefined, model: GoCamModel): string {
  if (!termId) return ""
  const obj = model.objects?.find((o) => o.id === termId)
  return obj?.label ?? termId
}

/** Dagre-style left-to-right layout via longest-path layering */
function layoutNodes(
  activities: Activity[],
  model: GoCamModel,
  colorMap: Map<string, ProcessColor>,
  connections?: ModelConnectionsResult,
): Node[] {
  // Build gene -> connected model count map
  const geneConnCount = new Map<string, number>()
  if (connections) {
    for (const conn of connections.connections) {
      geneConnCount.set(conn.gene_id, conn.other_models.length)
    }
  }
  const idToIdx = new Map<string, number>()
  activities.forEach((a, i) => idToIdx.set(a.id, i))

  const layers: number[] = new Array(activities.length).fill(0)
  const visited = new Set<number>()

  function dfs(idx: number): number {
    if (visited.has(idx)) return layers[idx]
    visited.add(idx)
    const act = activities[idx]
    let maxChild = -1
    for (const ca of act.causal_associations ?? []) {
      const childIdx = idToIdx.get(ca.downstream_activity ?? "")
      if (childIdx !== undefined) {
        maxChild = Math.max(maxChild, dfs(childIdx))
      }
    }
    layers[idx] = maxChild + 1
    return layers[idx]
  }
  activities.forEach((_, i) => dfs(i))

  const maxLayer = Math.max(...layers, 0)
  const reversedLayers = layers.map((l) => maxLayer - l)

  const layerGroups = new Map<number, number[]>()
  reversedLayers.forEach((l, i) => {
    const group = layerGroups.get(l) ?? []
    group.push(i)
    layerGroups.set(l, group)
  })

  const LAYER_GAP = 300
  const NODE_H = 90
  const NODE_GAP = 40

  return activities.map((activity, i) => {
    const layer = reversedLayers[i]
    const group = layerGroups.get(layer) ?? [i]
    const posInGroup = group.indexOf(i)
    const groupHeight = group.length * (NODE_H + NODE_GAP) - NODE_GAP
    const startY = -groupHeight / 2

    const geneProduct = activity.enabled_by?.term ?? ""
    const bpTerm = activity.part_of?.term
    const color = getProcessColor(bpTerm, colorMap)

    return {
      id: activity.id,
      type: "activity",
      position: {
        x: layer * LAYER_GAP,
        y: startY + posInGroup * (NODE_H + NODE_GAP),
      },
      data: {
        label: resolveLabel(geneProduct, model),
        geneProduct,
        molecularFunction: resolveLabel(activity.molecular_function?.term, model),
        biologicalProcess: resolveLabel(bpTerm, model),
        cellularComponent: resolveLabel(activity.occurs_in?.term, model),
        isExpanded: false,
        bgColor: color.bg,
        borderColor: color.border,
        textColor: color.text,
        connectedModelCount: geneConnCount.get(geneProduct) ?? 0,
      } satisfies ActivityNodeData,
    }
  })
}

function buildEdges(activities: Activity[], model: GoCamModel): Edge[] {
  const edges: Edge[] = []
  for (const activity of activities) {
    for (const ca of activity.causal_associations ?? []) {
      if (!ca.downstream_activity) continue
      const predLabel = resolveLabel(ca.predicate, model) || ca.predicate || ""
      const edgeType = classifyPredicate(ca.predicate)
      const edgeColor = EDGE_COLORS[edgeType]

      edges.push({
        id: `${activity.id}->${ca.downstream_activity}`,
        source: activity.id,
        target: ca.downstream_activity,
        label: predLabel,
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

function activityPanelKey(activity: Activity): string {
  return JSON.stringify(activity)
}

export function GraphView() {
  const { modelId } = useParams<{ modelId: string }>()
  const queryClient = useQueryClient()
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null)

  const { data: model, isLoading: modelLoading } = useQuery({
    queryKey: ["model", modelId],
    queryFn: () => fetchModel(modelId!),
    enabled: !!modelId,
  })

  // Fetch cross-model connections for this model's gene products
  const { data: connections } = useQuery({
    queryKey: ["connections", modelId],
    queryFn: () => fetchModelConnections(modelId!),
    enabled: !!modelId,
  })

  // Build process color map from all activities
  const { colorMap, processLabels } = useMemo(() => {
    if (!model?.activities) return { colorMap: new Map(), processLabels: new Map() }
    const bpTerms = model.activities.map((a) => a.part_of?.term)
    const cm = buildProcessColorMap(bpTerms)
    const labels = new Map<string, string>()
    for (const termId of cm.keys()) {
      labels.set(termId, resolveLabel(termId, model))
    }
    return { colorMap: cm, processLabels: labels }
  }, [model])

  const initialNodes = useMemo(() => {
    if (!model?.activities) return []
    return layoutNodes(model.activities, model, colorMap, connections ?? undefined)
  }, [model, colorMap, connections])

  const initialEdges = useMemo(() => {
    if (!model?.activities) return []
    return buildEdges(model.activities, model)
  }, [model])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const selectedActivity = model?.activities?.find((activity) => activity.id === selectedActivityId) ?? null

  // Sync when model loads or changes (after save)
  useEffect(() => {
    setNodes(initialNodes)
  }, [initialNodes, setNodes])
  useEffect(() => {
    setEdges(initialEdges)
  }, [initialEdges, setEdges])

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      // Toggle inline expansion
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === node.id) {
            const data = n.data as unknown as ActivityNodeData
            return { ...n, data: { ...data, isExpanded: !data.isExpanded } }
          }
          return n
        })
      )
      // Show detail/edit panel
      setSelectedActivityId((prev) => (prev === node.id ? null : node.id))
    },
    [setNodes]
  )

  // Handle drag-to-connect: opens the predicate picker dialog
  const onConnect: OnConnect = useCallback(
    (connection) => {
      if (connection.source && connection.target && connection.source !== connection.target) {
        setPendingConnection(connection)
      }
    },
    []
  )

  function handleEdgeCreated() {
    // Refetch model to get the new edge
    queryClient.invalidateQueries({ queryKey: ["model", modelId] })
    setSelectedActivityId(null)
  }

  if (modelLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!model) {
    return <div className="p-8 text-destructive">Model not found</div>
  }

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col">
        {/* Header bar */}
        <div className="h-12 border-b flex items-center gap-3 px-3 shrink-0 bg-card">
          <Link to="/">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{model.title}</p>
            <p className="text-[10px] text-muted-foreground font-mono">{model.id}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {model.activities?.length ?? 0} activities
            </span>
            <Button
              variant={editMode ? "default" : "outline"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setEditMode(!editMode)}
            >
              <Pencil className="h-3 w-3 mr-1" />
              {editMode ? "Editing" : "Edit"}
            </Button>
          </div>
        </div>

        {/* React Flow canvas */}
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange as OnNodesChange<Node>}
            onEdgesChange={onEdgesChange as OnEdgesChange<Edge>}
            onNodeClick={onNodeClick}
            onConnect={editMode ? onConnect : undefined}
            nodeTypes={nodeTypes}
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
                const d = node.data as unknown as ActivityNodeData
                return d?.borderColor ?? "#a3a3a3"
              }}
            />
          </ReactFlow>
          <ProcessLegend processColors={colorMap} processLabels={processLabels} />
          {editMode && (
            <div className="absolute bottom-2 left-14 z-10 bg-card/90 backdrop-blur border rounded px-2 py-1">
              <p className="text-[10px] text-muted-foreground">
                Drag from one node handle to another to create a causal edge
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Side panel: edit mode or read-only */}
      {selectedActivity && model && (
        editMode ? (
          <ActivityEditPanel
            key={activityPanelKey(selectedActivity)}
            activity={selectedActivity}
            model={model}
            onClose={() => setSelectedActivityId(null)}
            onSaved={() => {}}
          />
        ) : (
          <ActivityDetailPanel
            activity={selectedActivity}
            model={model}
            onClose={() => setSelectedActivityId(null)}
            geneConnection={
              connections?.connections.find(
                (c) => c.gene_id === selectedActivity.enabled_by?.term
              )
            }
          />
        )
      )}

      {/* New edge dialog */}
      {pendingConnection && model && (
        <NewEdgeDialog
          open={!!pendingConnection}
          sourceActivityId={pendingConnection.source!}
          targetActivityId={pendingConnection.target!}
          model={model}
          onClose={() => setPendingConnection(null)}
          onCreated={handleEdgeCreated}
        />
      )}
    </div>
  )
}
