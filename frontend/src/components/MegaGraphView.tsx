import { useMemo, useState, useCallback } from "react"
import { Link } from "react-router-dom"
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
  MarkerType,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { ArrowLeft, Loader2, Network } from "lucide-react"

import { fetchConnectedModels, fetchGraph, type MegaGraph } from "@/lib/api"
import { classifyPredicate, EDGE_COLORS } from "@/lib/colors"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"

// Color palette for different source models
const MODEL_COLORS = [
  "#3b82f6", "#22c55e", "#f59e0b", "#ec4899", "#6366f1",
  "#f97316", "#14b8a6", "#8b5cf6", "#eab308", "#0ea5e9",
  "#d946ef", "#ef4444",
]

function buildMegaNodes(graph: MegaGraph, modelColorMap: Map<string, string>): Node[] {
  // Simple force-directed-ish layout: hash position from node ID
  const nodes: Node[] = graph.nodes.map((n, i) => {
    const angle = (i / graph.nodes.length) * 2 * Math.PI
    const radius = 200 + Math.random() * 300
    const modelId = Array.isArray(n.model_id) ? n.model_id[0] : n.model_id
    const color = modelColorMap.get(modelId ?? "") ?? "#94a3b8"
    return {
      id: n.id,
      position: {
        x: Math.cos(angle) * radius + (Math.random() - 0.5) * 100,
        y: Math.sin(angle) * radius + (Math.random() - 0.5) * 100,
      },
      data: {
        label: n.label || n.id,
        modelId: modelId,
        geneProduct: n.gene_product,
        isShared: false, // will be set below
      },
      style: {
        background: `${color}20`,
        border: `2px solid ${color}`,
        borderRadius: "8px",
        padding: "8px 12px",
        fontSize: "11px",
        fontWeight: 600,
        color: color,
      },
    }
  })

  // Mark shared nodes (appear in edges from multiple models)
  const nodeModels = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    const mid = Array.isArray(edge.model_id) ? edge.model_id : [edge.model_id]
    for (const m of mid) {
      if (!m) continue
      for (const nid of [edge.source, edge.target]) {
        if (!nodeModels.has(nid)) nodeModels.set(nid, new Set())
        nodeModels.get(nid)!.add(m)
      }
    }
  }
  for (const node of nodes) {
    const models = nodeModels.get(node.id)
    if (models && models.size > 1) {
      node.data.isShared = true
      node.style = {
        ...node.style,
        background: "#fef3c7",
        border: "3px solid #f59e0b",
        color: "#92400e",
        boxShadow: "0 0 12px rgba(245, 158, 11, 0.4)",
      }
    }
  }

  return nodes
}

function buildMegaEdges(graph: MegaGraph, modelColorMap: Map<string, string>): Edge[] {
  return graph.edges.map((e, i) => {
    const predicate = Array.isArray(e.causal_predicate) ? e.causal_predicate[0] : e.causal_predicate
    const modelId = Array.isArray(e.model_id) ? e.model_id[0] : e.model_id
    const edgeType = classifyPredicate(predicate)
    const edgeColor = EDGE_COLORS[edgeType]
    const modelColor = modelColorMap.get(modelId ?? "") ?? edgeColor.stroke

    return {
      id: `mega-${i}`,
      source: e.source,
      target: e.target,
      label: predicate ?? "",
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: modelColor },
      style: { strokeWidth: 1.5, stroke: modelColor, opacity: 0.7 },
      labelStyle: { fontSize: 8, fill: edgeColor.label },
      labelBgStyle: { fill: "#ffffff", fillOpacity: 0.8 },
      labelBgPadding: [3, 1] as [number, number],
      labelBgBorderRadius: 2,
    }
  })
}

export function MegaGraphView() {
  const [selectedNode, setSelectedNode] = useState<string | null>(null)

  const { data: connected, isLoading: connLoading } = useQuery({
    queryKey: ["connected-models"],
    queryFn: () => fetchConnectedModels(),
  })

  const connectedIds = connected?.model_ids ?? []

  const { data: graph, isLoading: graphLoading } = useQuery({
    queryKey: ["mega-graph", connectedIds],
    queryFn: () => fetchGraph(connectedIds),
    enabled: connectedIds.length > 0,
  })

  const modelColorMap = useMemo(() => {
    const map = new Map<string, string>()
    connectedIds.forEach((id, i) => {
      map.set(`gomodel:${id}`, MODEL_COLORS[i % MODEL_COLORS.length])
    })
    return map
  }, [connectedIds])

  const initialNodes = useMemo(() => {
    if (!graph) return []
    return buildMegaNodes(graph, modelColorMap)
  }, [graph, modelColorMap])

  const initialEdges = useMemo(() => {
    if (!graph) return []
    return buildMegaEdges(graph, modelColorMap)
  }, [graph, modelColorMap])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  useMemo(() => {
    if (initialNodes.length > 0) setNodes(initialNodes)
  }, [initialNodes, setNodes])
  useMemo(() => {
    if (initialEdges.length > 0) setEdges(initialEdges)
  }, [initialEdges, setEdges])

  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    setSelectedNode((prev) => (prev === node.id ? null : node.id))
  }, [])

  const isLoading = connLoading || graphLoading

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col">
        <div className="h-12 border-b flex items-center gap-3 px-3 shrink-0 bg-card">
          <Link to="/">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <Network className="h-4 w-4 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">Mega-Graph</p>
            <p className="text-[10px] text-muted-foreground">
              {connectedIds.length} connected models
              {graph && ` · ${graph.node_count} genes · ${graph.edge_count} edges`}
            </p>
          </div>
        </div>

        <div className="flex-1 relative">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground text-sm">
                {connLoading ? "Discovering connections..." : "Building mega-graph..."}
              </span>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange as OnNodesChange<Node>}
              onEdgesChange={onEdgesChange as OnEdgesChange<Edge>}
              onNodeClick={onNodeClick}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              minZoom={0.05}
              maxZoom={4}
            >
              <Background gap={30} size={1} />
              <Controls />
              <MiniMap className="!bg-muted/80" />
            </ReactFlow>
          )}

          {/* Model color legend */}
          {!isLoading && connectedIds.length > 0 && (
            <div className="absolute top-2 right-2 z-10 bg-card/95 backdrop-blur border rounded-lg shadow-md p-2.5 max-w-52">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Models
              </p>
              <div className="space-y-1">
                {connectedIds.map((id, i) => (
                  <div key={id} className="flex items-center gap-1.5">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: MODEL_COLORS[i % MODEL_COLORS.length] }}
                    />
                    <Link to={`/model/${id}`} className="text-[10px] truncate hover:underline">
                      {id}
                    </Link>
                  </div>
                ))}
              </div>
              <div className="border-t mt-2 pt-1.5">
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ backgroundColor: "#fef3c7", border: "1.5px solid #f59e0b" }}
                  />
                  <span className="text-[10px]">Shared gene (multi-model)</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Shared genes panel */}
      {connected && connected.shared_genes.length > 0 && (
        <div className="w-72 border-l bg-card flex flex-col h-full">
          <div className="p-3 border-b">
            <h3 className="font-semibold text-sm">Shared Gene Products</h3>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {connected.connection_count} genes shared across models
            </p>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {connected.shared_genes.map((g) => (
                <div
                  key={g.gene_id}
                  className={`rounded border p-2 text-xs cursor-pointer transition-colors ${
                    selectedNode === g.gene_id ? "bg-amber-50 border-amber-300" : "hover:bg-muted/50"
                  }`}
                  onClick={() => setSelectedNode(g.gene_id)}
                >
                  <p className="font-medium">{g.label || g.gene_id}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">{g.gene_id}</p>
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {g.model_ids.map((mid) => (
                      <Badge key={mid} variant="outline" className="text-[9px] h-4 px-1">
                        {mid.slice(-8)}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
