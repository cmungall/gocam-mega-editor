import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { ExternalLink, GitBranch, Loader2, Network, Search } from "lucide-react"

import type { GoCamModel } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

export interface NeighboringModelSummary {
  id: string
  title: string
  activityCount: number
  sharedGeneCount: number
  sharedGenes: { id: string; label: string | null }[]
}

interface Props {
  model: GoCamModel
  neighboringModels: NeighboringModelSummary[]
  loading?: boolean
  workspaceModelIds?: string[]
  focusedModelId?: string
  onImportModel?: (modelId: string) => void
  onFocusModel?: (modelId: string) => void
}

function formatGeneLabel(gene: { id: string; label: string | null }): string {
  if (gene.label && gene.label !== gene.id) {
    return gene.label
  }
  return gene.id
}

export function NeighboringModelsSheet({
  model,
  neighboringModels,
  loading = false,
  workspaceModelIds = [],
  focusedModelId,
  onImportModel,
  onFocusModel,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const currentModelId = model.id.replace(/^gomodel:/, "")
  const filteredNeighbors = useMemo(() => {
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
  }, [neighboringModels, query])

  return (
    <>
      <Button
        variant={open ? "default" : "secondary"}
        size="sm"
        className="h-8 shrink-0 rounded-full px-3 text-xs shadow-sm"
        onClick={() => setOpen(true)}
        title="Browse neighboring models connected by shared genes"
      >
        <Network className="mr-1 h-3 w-3" />
        Neighbors
        <span className="ml-1 rounded-full bg-background/80 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
          {loading ? "…" : neighboringModels.length}
        </span>
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-lg">
          <SheetHeader className="border-b">
            <SheetTitle>Neighboring Models</SheetTitle>
            <SheetDescription>
              Models connected to this pathway by shared gene products. Import a model to bring it into the current level-2 workspace.
            </SheetDescription>
          </SheetHeader>

          <ScrollArea className="flex-1">
            <div className="space-y-3 p-4">
              <div className="rounded-xl border bg-muted/30 p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter by model title, ID, or shared gene"
                    className="pl-8"
                  />
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {filteredNeighbors.length} of {neighboringModels.length} neighboring model{neighboringModels.length === 1 ? "" : "s"} shown
                </p>
              </div>

              {loading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading neighboring models...
                </div>
              )}

              {!loading && neighboringModels.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No neighboring models were found for this pathway in the current local corpus.
                </div>
              )}

              {!loading && neighboringModels.length > 0 && filteredNeighbors.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No neighboring models match the current filter.
                </div>
              )}

              {filteredNeighbors.map((neighbor) => {
                const imported = workspaceModelIds.includes(neighbor.id)
                const focused = focusedModelId === neighbor.id
                const visibleGenes = neighbor.sharedGenes.slice(0, 5)
                const hiddenGeneCount = Math.max(neighbor.sharedGenes.length - visibleGenes.length, 0)

                return (
                  <div key={neighbor.id} className="rounded-xl border bg-card p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium leading-snug">{neighbor.title}</p>
                          {imported && (
                            <Badge variant={focused ? "default" : "secondary"} className="text-[10px]">
                              {focused ? "Focused" : "Imported"}
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <GitBranch className="h-3 w-3" />
                            {neighbor.sharedGeneCount} shared gene{neighbor.sharedGeneCount === 1 ? "" : "s"}
                          </span>
                          <span>{neighbor.activityCount} activities</span>
                          <span className="font-mono">{neighbor.id}</span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <Link
                          to={`/model/${neighbor.id}`}
                          className="inline-flex h-7 items-center gap-1 rounded-full border bg-background px-2.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          title={`Open ${neighbor.title} as its own model page`}
                        >
                          <span>Open</span>
                          <ExternalLink className="h-3 w-3" />
                        </Link>

                        {neighbor.id === currentModelId ? (
                          <Badge variant="secondary" className="text-[10px]">
                            Current
                          </Badge>
                        ) : imported ? (
                          <Button
                            variant={focused ? "secondary" : "outline"}
                            size="sm"
                            className="h-7 rounded-full px-2.5 text-[10px]"
                            onClick={() => onFocusModel?.(neighbor.id)}
                          >
                            {focused ? "Focused" : "Focus"}
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 rounded-full px-2.5 text-[10px]"
                            onClick={() => onImportModel?.(neighbor.id)}
                          >
                            Import
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {visibleGenes.map((gene) => (
                        <Badge
                          key={`${neighbor.id}:${gene.id}`}
                          variant="outline"
                          className="max-w-48 truncate text-[10px]"
                          title={gene.label && gene.label !== gene.id ? `${gene.label} (${gene.id})` : gene.id}
                        >
                          {formatGeneLabel(gene)}
                        </Badge>
                      ))}
                      {hiddenGeneCount > 0 && (
                        <Badge variant="secondary" className="text-[10px]">
                          +{hiddenGeneCount} more
                        </Badge>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  )
}
