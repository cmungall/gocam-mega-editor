import { useMemo, useState, useCallback, useEffect } from "react"
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
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { ArrowLeft, Loader2, Network } from "lucide-react"

import {
  fetchConnectedModels,
  type SpeciesCluster,
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

function getSpeciesColor(taxon: string | null) {
  if (!taxon) return DEFAULT_COLOR
  return SPECIES_COLORS[taxon] ?? DEFAULT_COLOR
}

function buildModelNodes(cluster: SpeciesCluster, xOffset: number): Node[] {
  const color = getSpeciesColor(cluster.taxon)
  const models = cluster.models
  // Circle layout within the cluster
  const radius = Math.max(150, models.length * 40)

  return models.map((m, i) => {
    const angle = (i / models.length) * 2 * Math.PI - Math.PI / 2
    const x = xOffset + Math.cos(angle) * radius
    const y = Math.sin(angle) * radius
    // Node size scales with activity count
    const size = Math.max(80, Math.min(200, 60 + m.activity_count * 12))

    return {
      id: m.id,
      position: { x, y },
      data: {
        label: m.title,
        activityCount: m.activity_count,
        taxon: cluster.taxon_label ?? cluster.taxon,
      },
      style: {
        background: color.bg,
        border: `2px solid ${color.border}`,
        borderRadius: "10px",
        padding: "10px 14px",
        width: `${size}px`,
        fontSize: "11px",
        fontWeight: 600,
        color: color.text,
        cursor: "pointer",
      },
    }
  })
}

function buildModelEdges(cluster: SpeciesCluster): Edge[] {
  const color = getSpeciesColor(cluster.taxon)
  return cluster.edges.map((e, i) => {
    const maxWeight = Math.max(...cluster.edges.map((x) => x.weight), 1)
    const thickness = 1.5 + (e.weight / maxWeight) * 4

    return {
      id: `${cluster.taxon}-${i}`,
      source: e.source,
      target: e.target,
      label: `${e.weight}`,
      style: {
        strokeWidth: thickness,
        stroke: color.border,
        opacity: 0.5 + (e.weight / maxWeight) * 0.5,
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

  const { data: connected, isLoading } = useQuery({
    queryKey: ["connected-models"],
    queryFn: () => fetchConnectedModels(),
  })

  const clusters = connected?.species_clusters ?? []
  const visibleClusters = selectedCluster
    ? clusters.filter((c) => (c.taxon ?? "unknown") === selectedCluster)
    : clusters

  // Stable key for when data actually changes
  const dataKey = connected ? `${connected.total_models}-${connected.total_connections}-${selectedCluster ?? "all"}` : ""

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  useEffect(() => {
    if (!connected) return
    const allNodes: Node[] = []
    let xOffset = 0
    for (const cluster of visibleClusters) {
      allNodes.push(...buildModelNodes(cluster, xOffset))
      xOffset += Math.max(500, cluster.models.length * 120)
    }
    setNodes(allNodes)
    setEdges(visibleClusters.flatMap(buildModelEdges))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey])

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => { navigate(`/model/${node.id}`) },
    [navigate]
  )

  const onEdgeMouseEnter: EdgeMouseHandler = useCallback(
    (_event, edge) => {
      // Find the matching API edge to get shared genes
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
        <div className="h-12 border-b flex items-center gap-3 px-3 shrink-0 bg-card">
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
          {/* Species filter buttons */}
          <div className="ml-auto flex items-center gap-1.5">
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

        {/* Graph */}
        <div className="flex-1 relative">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground text-sm">Discovering model connections...</span>
            </div>
          ) : (
            <ReactFlow
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

          {/* Edge hover tooltip */}
          {hoveredEdge && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 bg-card border rounded-lg shadow-lg p-3 max-w-sm">
              <p className="text-xs font-semibold mb-1.5">
                {hoveredEdge.weight} shared gene{hoveredEdge.weight !== 1 ? "s" : ""}
              </p>
              <div className="flex flex-wrap gap-1">
                {hoveredEdge.shared_genes.map((g) => (
                  <Badge key={g.gene_id} variant="secondary" className="text-[10px]">
                    {g.label || g.gene_id}
                  </Badge>
                ))}
              </div>
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
