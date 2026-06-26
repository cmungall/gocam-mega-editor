import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { CircleAlert, ExternalLink, GitBranch, Loader2, Network, Search } from "lucide-react"

import type { GoCamModel } from "@/lib/api"
import { filterNeighboringModels, type NeighboringModelSummary } from "@/lib/neighbors"
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

interface Props {
  model: GoCamModel
  neighboringModels: NeighboringModelSummary[]
  loading?: boolean
  errorMessage?: string | null
  workspaceModelIds?: string[]
  focusedModelId?: string
  open?: boolean
  query?: string
  onOpenChange?: (open: boolean) => void
  onQueryChange?: (query: string) => void
  onImportModel?: (modelId: string) => void
  onFocusModel?: (modelId: string) => void
  onSelectConnectorGene?: (geneId: string) => void
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
  errorMessage = null,
  workspaceModelIds = [],
  focusedModelId,
  open: controlledOpen,
  query: controlledQuery,
  onOpenChange,
  onQueryChange,
  onImportModel,
  onFocusModel,
  onSelectConnectorGene,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [internalQuery, setInternalQuery] = useState("")
  const open = controlledOpen ?? internalOpen
  const query = controlledQuery ?? internalQuery
  const currentModelId = model.id.replace(/^gomodel:/, "")
  const filteredNeighbors = useMemo(
    () => filterNeighboringModels(neighboringModels, query),
    [neighboringModels, query]
  )

  function setOpen(nextOpen: boolean) {
    if (controlledOpen === undefined) {
      setInternalOpen(nextOpen)
    }
    onOpenChange?.(nextOpen)
  }

  function setQuery(nextQuery: string) {
    if (controlledQuery === undefined) {
      setInternalQuery(nextQuery)
    }
    onQueryChange?.(nextQuery)
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) {
      setQuery("")
    }
  }

  return (
    <>
      <Button
        variant={open ? "default" : "secondary"}
        size="sm"
        className="h-8 shrink-0 rounded-full px-3 text-xs shadow-sm"
        onClick={() => setOpen(true)}
        title="Browse neighboring models connected by model-link criteria"
      >
        <Network className="mr-1 h-3 w-3" />
        Neighbors
        <span
          className={`
            ml-1 rounded-full bg-background/80 px-1.5 py-0.5 text-[10px] font-medium leading-none
            ${errorMessage ? "text-destructive" : "text-muted-foreground"}
          `}
        >
          {errorMessage ? "!" : loading ? "…" : neighboringModels.length}
        </span>
      </Button>

      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-lg">
          <SheetHeader className="border-b">
            <SheetTitle>Neighbors of {model.title}</SheetTitle>
            <SheetDescription>
              Connected to <span className="font-mono">{currentModelId}</span> by fast model-link criteria. Import a model to bring it into the current level-2 workspace, or click a connector gene to jump to it in the graph.
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
                    placeholder="Filter by model title, ID, gene, or link type"
                    className="pl-8"
                    disabled={Boolean(errorMessage)}
                  />
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {errorMessage
                    ? "Neighboring models unavailable"
                    : `${filteredNeighbors.length} of ${neighboringModels.length} neighboring model${neighboringModels.length === 1 ? "" : "s"} shown`}
                </p>
              </div>

              {loading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading neighboring models...
                </div>
              )}

              {!loading && errorMessage && (
                <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">Could not load neighboring models</p>
                    <p className="mt-1 text-xs text-destructive/80">{errorMessage}</p>
                  </div>
                </div>
              )}

              {!loading && !errorMessage && neighboringModels.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No neighboring models were found for this pathway in the current local corpus.
                </div>
              )}

              {!loading && !errorMessage && neighboringModels.length > 0 && filteredNeighbors.length === 0 && (
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
                          <span>score {neighbor.linkScore}</span>
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

                    {neighbor.linkCriteria.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {neighbor.linkCriteria.slice(0, 4).map((criterion) => (
                          <Badge key={criterion.type} variant="secondary" className="text-[10px]">
                            {criterion.label}
                            {criterion.count > 1 ? ` (${criterion.count})` : ""}
                          </Badge>
                        ))}
                        {neighbor.linkCriteria.length > 4 && (
                          <Badge variant="secondary" className="text-[10px]">
                            +{neighbor.linkCriteria.length - 4} more
                          </Badge>
                        )}
                      </div>
                    )}

                    {visibleGenes.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {visibleGenes.map((gene) => (
                        <button
                          key={`${neighbor.id}:${gene.id}`}
                          type="button"
                          className="inline-flex max-w-48 items-center rounded-full border bg-background px-2 py-0.5 text-[10px] transition-colors hover:bg-muted"
                          title={
                            gene.label && gene.label !== gene.id
                              ? `Locate ${gene.label} (${gene.id}) in ${model.title}`
                              : `Locate ${gene.id} in ${model.title}`
                          }
                          onClick={() => {
                            onSelectConnectorGene?.(gene.id)
                            handleOpenChange(false)
                          }}
                        >
                          {formatGeneLabel(gene)}
                        </button>
                      ))}
                      {hiddenGeneCount > 0 && (
                        <Badge variant="secondary" className="text-[10px]">
                          +{hiddenGeneCount} more
                        </Badge>
                      )}
                    </div>
                    )}
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
