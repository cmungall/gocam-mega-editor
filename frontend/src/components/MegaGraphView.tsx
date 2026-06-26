import { useState, useCallback, useEffect, useMemo } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
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
  type NodeMouseHandler,
  type EdgeMouseHandler,
  MarkerType,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { ArrowLeft, CircleDot, Columns3, Loader2, Network, SlidersHorizontal } from "lucide-react"

import {
  fetchConnectedModels,
  type SpeciesCluster,
  type ModelNode as ApiModelNode,
  type ModelEdge as ApiModelEdge,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"

const SPECIES_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  "NCBITaxon:10090": { bg: "#dbeafe", border: "#3b82f6", text: "#1e40af" },   // mouse - blue
  "NCBITaxon:9606":  { bg: "#dcfce7", border: "#22c55e", text: "#166534" },   // human - green
  "NCBITaxon:6239":  { bg: "#fef3c7", border: "#f59e0b", text: "#92400e" },   // C. elegans - amber
  "NCBITaxon:7955":  { bg: "#fce7f3", border: "#ec4899", text: "#9d174d" },   // zebrafish - pink
  "NCBITaxon:7227":  { bg: "#e0e7ff", border: "#6366f1", text: "#3730a3" },   // drosophila - indigo
  "NCBITaxon:559292": { bg: "#ffedd5", border: "#f97316", text: "#9a3412" },  // yeast - orange
}
const DEFAULT_COLOR = { bg: "#f5f5f5", border: "#a3a3a3", text: "#525252" }
const EMPTY_CLUSTERS: SpeciesCluster[] = []
const MAX_CANVAS_MODELS = 250
const MAX_CANVAS_EDGES = 1500
const MAX_SPECIES_FLOW_TOTAL_MODELS = 500
const MAX_SPECIES_FLOW_TOTAL_EDGES = 2200
const FLOW_NODE_X_GAP = 260
const FLOW_NODE_Y_GAP = 116
const FLOW_RANK_GAP = 72
const FLOW_SPECIES_GAP = 180
const FLOW_MAX_COLUMNS_PER_RANK = 3
const CRITERION_ORDER = [
  "full_activity_signature",
  "terminal_to_initial",
  "chemical_flow",
  "gene_mf",
  "shared_chemical",
  "shared_gene",
]
const CRITERION_SHORT_LABELS: Record<string, string> = {
  shared_gene: "gene",
  gene_mf: "gene+MF",
  full_activity_signature: "gene+MF+BP+CC",
  terminal_to_initial: "boundary",
  shared_chemical: "CHEBI",
  chemical_flow: "flow",
}
type MegaLayoutMode = "species-flow" | "circle"

interface RenderPlan {
  clusters: SpeciesCluster[]
  omittedClusters: SpeciesCluster[]
  blocked: boolean
}

function getSpeciesColor(taxon: string | null) {
  if (!taxon) return DEFAULT_COLOR
  return SPECIES_COLORS[taxon] ?? DEFAULT_COLOR
}

function criterionRank(type: string) {
  const index = CRITERION_ORDER.indexOf(type)
  return index === -1 ? CRITERION_ORDER.length : index
}

function strongestCriterion(edge: ApiModelEdge) {
  return [...(edge.criteria ?? [])].sort((left, right) => criterionRank(left.type) - criterionRank(right.type))[0]
}

function criterionLabel(type: string) {
  return CRITERION_SHORT_LABELS[type] ?? type
}

function edgeLabel(edge: ApiModelEdge) {
  const criterion = strongestCriterion(edge)
  if (!criterion) return `${edge.weight}`
  const label = criterionLabel(criterion.type)
  return criterion.count > 1 ? `${label} ${criterion.count}` : label
}

function filterClusterByCriterion(cluster: SpeciesCluster, criterionType: string | null): SpeciesCluster {
  if (!criterionType) return cluster
  const edges = cluster.edges.filter((edge) =>
    (edge.criteria ?? []).some((criterion) => criterion.type === criterionType)
  )
  const modelIds = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
  return {
    ...cluster,
    edges,
    models: cluster.models.filter((model) => modelIds.has(model.id)),
  }
}

function criterionOptions(clusters: SpeciesCluster[]) {
  const labels = new Map<string, string>()
  for (const cluster of clusters) {
    for (const edge of cluster.edges) {
      for (const criterion of edge.criteria ?? []) {
        labels.set(criterion.type, CRITERION_SHORT_LABELS[criterion.type] ?? criterion.label)
      }
    }
  }
  return [...labels.entries()].sort(([left], [right]) => criterionRank(left) - criterionRank(right))
}

function modelNodeWidth(model: ApiModelNode): number {
  return Math.max(80, Math.min(200, 60 + model.activity_count * 12))
}

function modelSortKey(model: ApiModelNode): string {
  return `${model.title.toLocaleLowerCase()} ${model.id}`
}

function buildModelNode(cluster: SpeciesCluster, model: ApiModelNode, x: number, y: number): Node {
  const color = getSpeciesColor(cluster.taxon)
  const width = modelNodeWidth(model)

  return {
    id: model.id,
    position: { x, y },
    data: {
      kind: "model",
      label: (
        <div className="min-w-0 text-left" title={model.title}>
          <span className="block truncate text-[11px] leading-tight">{model.title}</span>
        </div>
      ),
      activityCount: model.activity_count,
      taxon: cluster.taxon_label ?? cluster.taxon,
    },
    style: {
      background: color.bg,
      border: `2px solid ${color.border}`,
      borderRadius: "10px",
      padding: "10px 14px",
      width: `${width}px`,
      fontSize: "11px",
      fontWeight: 600,
      color: color.text,
      cursor: "pointer",
      overflow: "hidden",
      textAlign: "left",
    },
  }
}

function planRenderableClusters(
  clusters: SpeciesCluster[],
  layoutMode: MegaLayoutMode,
  hasSelectedCluster: boolean,
): RenderPlan {
  if (layoutMode === "circle") {
    const modelCount = clusters.reduce((sum, cluster) => sum + cluster.models.length, 0)
    const edgeCount = clusters.reduce((sum, cluster) => sum + cluster.edges.length, 0)
    const blocked = modelCount > MAX_CANVAS_MODELS || edgeCount > MAX_CANVAS_EDGES
    return {
      clusters: blocked ? [] : clusters,
      omittedClusters: blocked ? clusters : [],
      blocked,
    }
  }

  const renderable: SpeciesCluster[] = []
  const omittedClusters: SpeciesCluster[] = []
  let renderedModelCount = 0
  let renderedEdgeCount = 0

  for (const cluster of clusters) {
    const laneTooLarge =
      cluster.models.length > MAX_CANVAS_MODELS || cluster.edges.length > MAX_CANVAS_EDGES
    const totalTooLarge =
      !hasSelectedCluster &&
      (renderedModelCount + cluster.models.length > MAX_SPECIES_FLOW_TOTAL_MODELS ||
        renderedEdgeCount + cluster.edges.length > MAX_SPECIES_FLOW_TOTAL_EDGES)

    if (laneTooLarge || totalTooLarge) {
      omittedClusters.push(cluster)
      continue
    }

    renderable.push(cluster)
    renderedModelCount += cluster.models.length
    renderedEdgeCount += cluster.edges.length
  }

  return {
    clusters: renderable,
    omittedClusters,
    blocked: clusters.length > 0 && renderable.length === 0,
  }
}

function buildSpeciesLabelNode(cluster: SpeciesCluster, x: number, y: number, width: number): Node {
  const color = getSpeciesColor(cluster.taxon)
  const label = cluster.taxon_label ?? cluster.taxon ?? "Unknown species"

  return {
    id: `species-label:${cluster.taxon ?? "unknown"}`,
    position: { x, y },
    data: {
      kind: "species-label",
      label: (
        <div className="flex items-center justify-between gap-3">
          <span className="truncate">{label}</span>
          <span className="text-[10px] font-medium opacity-70">{cluster.models.length}</span>
        </div>
      ),
    },
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    style: {
      width: `${width}px`,
      borderRadius: "8px",
      border: `1px solid ${color.border}`,
      background: color.bg,
      color: color.text,
      padding: "8px 10px",
      fontSize: "11px",
      fontWeight: 700,
    },
  }
}

function buildCircleModelNodes(cluster: SpeciesCluster, xOffset: number): Node[] {
  const models = cluster.models
  // Circle layout within the cluster
  const radius = Math.max(150, models.length * 40)

  return models.map((m, i) => {
    const angle = (i / models.length) * 2 * Math.PI - Math.PI / 2
    const x = xOffset + Math.cos(angle) * radius
    const y = Math.sin(angle) * radius
    return buildModelNode(cluster, m, x, y)
  })
}

function directedEndpoints(edge: ApiModelEdge): [string, string] | null {
  if (edge.direction === "source_to_target") return [edge.source, edge.target]
  if (edge.direction === "target_to_source") return [edge.target, edge.source]
  return null
}

function buildFlowRanks(cluster: SpeciesCluster): Map<string, number> {
  const modelIds = new Set(cluster.models.map((model) => model.id))
  const ranks = new Map(cluster.models.map((model) => [model.id, 0]))
  const adjacency = new Map<string, Set<string>>()
  const indegrees = new Map(cluster.models.map((model) => [model.id, 0]))
  const directedEdges: [string, string][] = []

  for (const edge of cluster.edges) {
    const endpoints = directedEndpoints(edge)
    if (!endpoints) continue
    const [source, target] = endpoints
    if (source === target || !modelIds.has(source) || !modelIds.has(target)) continue

    const targets = adjacency.get(source) ?? new Set<string>()
    if (targets.has(target)) continue
    targets.add(target)
    adjacency.set(source, targets)
    indegrees.set(target, (indegrees.get(target) ?? 0) + 1)
    directedEdges.push([source, target])
  }

  const modelById = new Map(cluster.models.map((model) => [model.id, model]))
  const compareIds = (left: string, right: string) =>
    modelSortKey(modelById.get(left)!).localeCompare(modelSortKey(modelById.get(right)!))
  const queue = cluster.models
    .filter((model) => (indegrees.get(model.id) ?? 0) === 0)
    .map((model) => model.id)
    .sort(compareIds)
  const processed = new Set<string>()

  while (queue.length > 0) {
    const source = queue.shift()!
    processed.add(source)
    const sourceRank = ranks.get(source) ?? 0
    for (const target of [...(adjacency.get(source) ?? [])].sort(compareIds)) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, sourceRank + 1))
      const nextIndegree = (indegrees.get(target) ?? 0) - 1
      indegrees.set(target, nextIndegree)
      if (nextIndegree === 0) {
        queue.push(target)
        queue.sort(compareIds)
      }
    }
  }

  for (const model of cluster.models.filter((candidate) => !processed.has(candidate.id)).sort((a, b) => modelSortKey(a).localeCompare(modelSortKey(b)))) {
    const incomingRank = directedEdges
      .filter(([, target]) => target === model.id)
      .reduce((rank, [source]) => Math.max(rank, (ranks.get(source) ?? 0) + 1), 0)
    ranks.set(model.id, Math.max(ranks.get(model.id) ?? 0, incomingRank))
  }

  return ranks
}

function buildSpeciesFlowModelNodes(cluster: SpeciesCluster, xOffset: number): { nodes: Node[]; width: number } {
  const ranks = buildFlowRanks(cluster)
  const rankGroups = new Map<number, ApiModelNode[]>()

  for (const model of cluster.models) {
    const rank = ranks.get(model.id) ?? 0
    const group = rankGroups.get(rank) ?? []
    group.push(model)
    rankGroups.set(rank, group)
  }

  const rankEntries = [...rankGroups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rank, models]) => [
      rank,
      models.slice().sort((a, b) => modelSortKey(a).localeCompare(modelSortKey(b))),
    ] as const)

  const maxColumns = Math.max(
    1,
    Math.min(FLOW_MAX_COLUMNS_PER_RANK, ...rankEntries.map(([, models]) => models.length))
  )
  const maxNodeWidth = Math.max(...cluster.models.map(modelNodeWidth), 160)
  const columnWidth = Math.max(240, (maxColumns - 1) * FLOW_NODE_X_GAP + maxNodeWidth)
  const nodes: Node[] = [buildSpeciesLabelNode(cluster, xOffset, -74, columnWidth)]
  let yCursor = 0

  for (const [, models] of rankEntries) {
    const columns = Math.max(1, Math.min(maxColumns, models.length))
    const rows = Math.ceil(models.length / columns)

    models.forEach((model, index) => {
      const row = Math.floor(index / columns)
      const column = index % columns
      const rowCount = index >= (rows - 1) * columns ? models.length - (rows - 1) * columns : columns
      const lastRowOffset = row === rows - 1 ? ((columns - rowCount) * FLOW_NODE_X_GAP) / 2 : 0
      nodes.push(
        buildModelNode(
          cluster,
          model,
          xOffset + lastRowOffset + column * FLOW_NODE_X_GAP,
          yCursor + row * FLOW_NODE_Y_GAP,
        )
      )
    })

    yCursor += rows * FLOW_NODE_Y_GAP + FLOW_RANK_GAP
  }

  return { nodes, width: columnWidth }
}

function buildModelEdges(cluster: SpeciesCluster, layoutMode: MegaLayoutMode): Edge[] {
  if (cluster.edges.length === 0) return []
  const color = getSpeciesColor(cluster.taxon)
  const maxScore = Math.max(...cluster.edges.map((x) => x.score || x.weight), 1)
  return cluster.edges.map((e, i) => {
    const edgeScore = e.score || e.weight
    const thickness = 1.5 + (edgeScore / maxScore) * 4

    return {
      id: `${cluster.taxon}-${i}`,
      source: e.source,
      target: e.target,
      type: layoutMode === "species-flow" ? "smoothstep" : undefined,
      label: edgeLabel(e),
      markerEnd: e.direction === "source_to_target" || e.direction === "bidirectional"
        ? { type: MarkerType.ArrowClosed, color: color.border }
        : undefined,
      markerStart: e.direction === "target_to_source" || e.direction === "bidirectional"
        ? { type: MarkerType.ArrowClosed, color: color.border }
        : undefined,
      style: {
        strokeWidth: thickness,
        stroke: color.border,
        opacity: 0.45 + (edgeScore / maxScore) * 0.55,
      },
      labelStyle: {
        fontSize: 10,
        fontWeight: 700,
        fill: color.text,
      },
      labelBgStyle: {
        fill: "#ffffff",
        fillOpacity: 0.9,
      },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      data: { sharedGenes: e.shared_genes },
    }
  })
}

export function MegaGraphView() {
  const navigate = useNavigate()
  const [hoveredEdge, setHoveredEdge] = useState<ApiModelEdge | null>(null)
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null)
  const [selectedCriterion, setSelectedCriterion] = useState<string | null>(null)
  const [layoutMode, setLayoutMode] = useState<MegaLayoutMode>("species-flow")

  const { data: connected, isLoading } = useQuery({
    queryKey: ["connected-models"],
    queryFn: () => fetchConnectedModels(),
  })

  const clusters = connected?.species_clusters ?? EMPTY_CLUSTERS
  const availableCriteria = useMemo(() => criterionOptions(clusters), [clusters])
  const speciesFilteredClusters = selectedCluster
    ? clusters.filter((c) => (c.taxon ?? "unknown") === selectedCluster)
    : clusters
  const visibleClusters = useMemo(
    () =>
      speciesFilteredClusters
        .map((cluster) => filterClusterByCriterion(cluster, selectedCriterion))
        .filter((cluster) => cluster.models.length > 0 || !selectedCriterion),
    [selectedCriterion, speciesFilteredClusters]
  )
  const visibleModelCount = useMemo(
    () => visibleClusters.reduce((sum, cluster) => sum + cluster.models.length, 0),
    [visibleClusters]
  )
  const visibleEdgeCount = useMemo(
    () => visibleClusters.reduce((sum, cluster) => sum + cluster.edges.length, 0),
    [visibleClusters]
  )
  const renderPlan = useMemo(
    () => planRenderableClusters(visibleClusters, layoutMode, Boolean(selectedCluster)),
    [layoutMode, selectedCluster, visibleClusters]
  )
  const renderClusters = renderPlan.clusters
  const renderedModelCount = useMemo(
    () => renderClusters.reduce((sum, cluster) => sum + cluster.models.length, 0),
    [renderClusters]
  )
  const renderedEdgeCount = useMemo(
    () => renderClusters.reduce((sum, cluster) => sum + cluster.edges.length, 0),
    [renderClusters]
  )
  const omittedModelCount = useMemo(
    () => renderPlan.omittedClusters.reduce((sum, cluster) => sum + cluster.models.length, 0),
    [renderPlan.omittedClusters]
  )
  const omittedEdgeCount = useMemo(
    () => renderPlan.omittedClusters.reduce((sum, cluster) => sum + cluster.edges.length, 0),
    [renderPlan.omittedClusters]
  )
  const tooLargeForCanvas = renderPlan.blocked
  const selectedClusterLabel = visibleClusters[0]?.taxon_label ?? visibleClusters[0]?.taxon ?? "selected scope"

  // Stable key for when data actually changes
  const dataKey = connected
    ? `${connected.total_models}-${connected.total_connections}-${selectedCluster ?? "all"}-${selectedCriterion ?? "any"}-${layoutMode}`
    : ""

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  useEffect(() => {
    if (!connected || tooLargeForCanvas) {
      setNodes([])
      setEdges([])
      return
    }
    const nextNodes: Node[] = []
    let xOffset = 0
    for (const cluster of renderClusters) {
      if (layoutMode === "species-flow") {
        const layout = buildSpeciesFlowModelNodes(cluster, xOffset)
        nextNodes.push(...layout.nodes)
        xOffset += layout.width + FLOW_SPECIES_GAP
      } else {
        nextNodes.push(...buildCircleModelNodes(cluster, xOffset))
        xOffset += Math.max(500, cluster.models.length * 120)
      }
    }
    setNodes(nextNodes)
    setEdges(renderClusters.flatMap((cluster) => buildModelEdges(cluster, layoutMode)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, tooLargeForCanvas])

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.data?.kind !== "model") return
      navigate(`/model/${node.id}`)
    },
    [navigate]
  )

  const onEdgeMouseEnter: EdgeMouseHandler = useCallback(
    (_event, edge) => {
      // Find the matching API edge to show link criteria.
      for (const cluster of clusters) {
        const apiEdge = cluster.edges.find(
          (e) => (e.source === edge.source && e.target === edge.target) ||
                 (e.source === edge.target && e.target === edge.source)
        )
        if (apiEdge) {
          setHoveredEdge(apiEdge)
          return
        }
      }
    },
    [clusters]
  )

  const onEdgeMouseLeave: EdgeMouseHandler = useCallback(() => {
    setHoveredEdge(null)
  }, [])

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="min-h-12 border-b flex flex-wrap items-center gap-3 px-3 py-2 shrink-0 bg-card">
          <Link to="/">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <Network className="h-4 w-4 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">Model Network</p>
            <p className="text-[10px] text-muted-foreground">
              {connected
                ? `${connected.total_models} models · ${connected.total_connections} connections`
                : "Loading..."}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-full border bg-muted/40 p-1">
              <Button
                variant={layoutMode === "species-flow" ? "default" : "ghost"}
                size="sm"
                className="h-6 rounded-full px-2 text-[10px]"
                onClick={() => setLayoutMode("species-flow")}
              >
                <Columns3 className="h-3 w-3" />
                Species flow
              </Button>
              <Button
                variant={layoutMode === "circle" ? "default" : "ghost"}
                size="sm"
                className="h-6 rounded-full px-2 text-[10px]"
                onClick={() => setLayoutMode("circle")}
              >
                <CircleDot className="h-3 w-3" />
                Circle
              </Button>
            </div>

            {availableCriteria.length > 0 && (
              <div className="flex items-center gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                <Button
                  variant={selectedCriterion === null ? "default" : "outline"}
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={() => setSelectedCriterion(null)}
                >
                  Any
                </Button>
                {availableCriteria.map(([type, label]) => (
                  <Button
                    key={type}
                    variant={selectedCriterion === type ? "default" : "outline"}
                    size="sm"
                    className="h-6 text-[10px] px-2"
                    onClick={() => setSelectedCriterion(selectedCriterion === type ? null : type)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            )}

            {/* Species filter buttons */}
            <div className="flex items-center gap-1.5">
              <Button
                variant={selectedCluster === null ? "default" : "outline"}
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={() => setSelectedCluster(null)}
              >
                All
              </Button>
              {clusters.map((c) => {
                const color = getSpeciesColor(c.taxon)
                const key = c.taxon ?? "unknown"
                return (
                  <Button
                    key={key}
                    variant={selectedCluster === key ? "default" : "outline"}
                    size="sm"
                    className="h-6 text-[10px] px-2"
                    style={selectedCluster !== key ? { borderColor: color.border, color: color.text } : {}}
                    onClick={() => setSelectedCluster(selectedCluster === key ? null : key)}
                  >
                    {c.taxon_label ?? c.taxon ?? "Unknown"} ({c.models.length})
                  </Button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Graph */}
        <div className="flex-1 relative">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground text-sm">Discovering model connections...</span>
            </div>
          ) : tooLargeForCanvas ? (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-xl rounded-xl border bg-card p-6 shadow-sm">
                <p className="text-sm font-semibold">Network too large to render directly</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {selectedCluster
                    ? `${selectedClusterLabel} includes ${visibleModelCount} models and ${visibleEdgeCount} connections.`
                    : `All species together include ${visibleModelCount} models and ${visibleEdgeCount} connections.`}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  The current canvas is meant for smaller exploratory subsets. Use the species filter to narrow the scope, or open a model from the species list on the right.
                </p>
                {!selectedCluster && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {clusters.map((cluster) => {
                      const key = cluster.taxon ?? "unknown"
                      return (
                        <Button
                          key={key}
                          variant="outline"
                          size="sm"
                          className="h-7 text-[11px] px-2.5"
                          onClick={() => setSelectedCluster(key)}
                        >
                          {cluster.taxon_label ?? cluster.taxon ?? "Unknown"} ({cluster.models.length})
                        </Button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <ReactFlow
              key={dataKey}
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange as OnNodesChange<Node>}
              onEdgesChange={onEdgesChange as OnEdgesChange<Edge>}
              onNodeClick={onNodeClick}
              onEdgeMouseEnter={onEdgeMouseEnter}
              onEdgeMouseLeave={onEdgeMouseLeave}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              minZoom={0.1}
              maxZoom={2}
            >
              <Background gap={30} size={1} />
              <Controls />
              <MiniMap className="!bg-muted/80" />
            </ReactFlow>
          )}

          {!isLoading && !tooLargeForCanvas && renderPlan.omittedClusters.length > 0 && (
            <div className="absolute left-3 top-3 z-10 max-w-md rounded-lg border bg-card/95 px-3 py-2 shadow-sm backdrop-blur">
              <p className="text-[10px] font-semibold text-foreground">
                Showing {renderedModelCount} models / {renderedEdgeCount} connections
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Hidden: {renderPlan.omittedClusters.length} species lane{renderPlan.omittedClusters.length === 1 ? "" : "s"} ({omittedModelCount} models / {omittedEdgeCount} connections), including{" "}
                {renderPlan.omittedClusters
                  .slice(0, 3)
                  .map((cluster) => cluster.taxon_label ?? cluster.taxon ?? "Unknown")
                  .join(", ")}
                {renderPlan.omittedClusters.length > 3 ? ", ..." : ""}.
              </p>
            </div>
          )}

          {/* Edge hover tooltip */}
          {hoveredEdge && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 bg-card border rounded-lg shadow-lg p-3 max-w-sm">
              <p className="text-xs font-semibold mb-1.5">
                Score {hoveredEdge.score ?? hoveredEdge.weight}
                {hoveredEdge.direction && hoveredEdge.direction !== "undirected" ? ` · ${hoveredEdge.direction.replaceAll("_", " ")}` : ""}
              </p>
              {(hoveredEdge.criteria ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(hoveredEdge.criteria ?? []).map((criterion) => (
                    <Badge key={criterion.type} variant="secondary" className="text-[10px]">
                      {criterion.label}
                      {criterion.count > 1 ? ` (${criterion.count})` : ""}
                    </Badge>
                  ))}
                </div>
              )}
              {hoveredEdge.shared_genes.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {hoveredEdge.shared_genes.map((g) => (
                    <Badge key={g.gene_id} variant="outline" className="text-[10px]">
                      {g.label || g.gene_id}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Species summary panel */}
      <div className="w-64 border-l bg-card flex flex-col h-full">
        <div className="p-3 border-b">
          <h3 className="font-semibold text-sm">Species</h3>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-2">
            {clusters.map((cluster) => {
              const color = getSpeciesColor(cluster.taxon)
              return (
                <div key={cluster.taxon ?? "unknown"} className="rounded border p-2.5">
                  <div className="flex items-center gap-2 mb-1.5">
                    <div
                      className="w-3 h-3 rounded-sm"
                      style={{ backgroundColor: color.bg, border: `1.5px solid ${color.border}` }}
                    />
                    <p className="text-xs font-semibold" style={{ color: color.text }}>
                      {cluster.taxon_label ?? cluster.taxon ?? "Unknown"}
                    </p>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {cluster.models.length} models · {cluster.edges.length} connections
                  </p>
                  <div className="mt-1.5 space-y-0.5">
                    {cluster.models.slice(0, 5).map((m) => (
                      <Link key={m.id} to={`/model/${m.id}`}>
                        <p className="text-[10px] truncate hover:underline hover:text-primary">
                          {m.title}
                        </p>
                      </Link>
                    ))}
                    {cluster.models.length > 5 && (
                      <p className="text-[10px] text-muted-foreground">
                        +{cluster.models.length - 5} more
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
