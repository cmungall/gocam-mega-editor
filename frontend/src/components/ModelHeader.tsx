import { useMemo } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ExternalLink, Loader2, Pencil, Redo2, Undo2, X } from "lucide-react"

import { fetchModelChanges, redoLastModelChange, undoLastModelChange, type ChangeRecord, type GoCamModel } from "@/lib/api"
import type { NeighboringModelSummary } from "@/lib/neighbors"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ModelChangesSheet } from "./ModelChangesSheet"
import { NeighboringModelsSheet } from "./NeighboringModelsSheet"

interface Props {
  model: GoCamModel
  editMode: boolean
  onToggleEdit: () => void
  workspaceModels?: GoCamModel[]
  anchorModelId?: string
  focusedModelId?: string
  onFocusModel?: (modelId: string) => void
  neighboringModels?: NeighboringModelSummary[]
  neighboringModelsLoading?: boolean
  neighboringModelsError?: string | null
  onImportModel?: (modelId: string) => void
  onSelectConnectorGene?: (geneId: string) => void
  onRemoveImportedModel?: (modelId: string) => void
}

function resolveLabel(termId: string | null | undefined, model: GoCamModel): string {
  if (!termId) return ""
  const obj = model.objects?.find((o) => o.id === termId)
  return obj?.label ?? termId
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parsed)
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function summarizeList(values: string[], maxVisible = 2): string {
  if (values.length <= maxVisible) {
    return values.join(", ")
  }
  return `${values.slice(0, maxVisible).join(", ")} +${values.length - maxVisible}`
}

function providerLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "")
  } catch {
    return value
  }
}

function contributorSummary(model: GoCamModel): { label: string; title: string } | null {
  const names = unique(model.summary?.contributors ?? [])
  if (names.length > 0) {
    return {
      label: summarizeList(names),
      title: names.join(", "),
    }
  }

  const contributorIds = unique(
    (model.provenances ?? []).flatMap((prov) => prov.contributor ?? []).map((value) =>
      value.replace(/^https?:\/\/orcid\.org\//, "ORCID:")
    )
  )
  if (contributorIds.length === 0) return null

  return {
    label: `${contributorIds.length} contributor${contributorIds.length === 1 ? "" : "s"}`,
    title: contributorIds.join(", "),
  }
}

function modelLinks(model: GoCamModel): { label: string; href: string; title: string }[] {
  const shortId = model.id.replace(/^gomodel:/, "")
  return [
    {
      label: "VPE",
      href: `http://noctua.geneontology.org/workbench/noctua-visual-pathway-editor/?model_id=${encodeURIComponent(model.id)}`,
      title: "Open this model in the legacy Noctua visual pathway editor",
    },
    {
      label: "GO Page",
      href: `https://model.geneontology.org/${shortId}`,
      title: "Open the canonical GO model page",
    },
    {
      label: "Bioregistry",
      href: `https://bioregistry.io/go.model:${shortId}`,
      title: "Resolve this model CURIE in Bioregistry",
    },
  ]
}

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground">
      <span className="font-medium text-foreground/70">{label}</span>
      <span>{value}</span>
    </span>
  )
}

function DetailItem({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="min-w-0 truncate" title={title ?? value}>
      <span className="mr-1 font-medium text-foreground/70">{label}</span>
      {value}
    </span>
  )
}

function isGeneratedChange(change: ChangeRecord): boolean {
  const generatedBy = change.metadata?.generated_by
  return generatedBy === "undo" || generatedBy === "redo"
}

function shortModelId(value: string | GoCamModel): string {
  const raw = typeof value === "string" ? value : value.id
  return raw.replace(/^gomodel:/, "")
}

export function ModelHeader({
  model,
  editMode,
  onToggleEdit,
  workspaceModels = [],
  anchorModelId,
  focusedModelId,
  onFocusModel,
  neighboringModels = [],
  neighboringModelsLoading = false,
  neighboringModelsError = null,
  onImportModel,
  onSelectConnectorGene,
  onRemoveImportedModel,
}: Props) {
  const queryClient = useQueryClient()
  const shortId = shortModelId(model)
  const modelId = shortId
  const bioregistryCurie = `go.model:${shortId}`
  const taxonLabel = resolveLabel(model.taxon, model)
  const status = model.status ?? model.summary?.status ?? null
  const updated = formatDate(model.date_modified ?? model.summary?.date)
  const groups = unique(model.summary?.groups ?? [])
  const providers = unique(
    (model.provenances ?? []).flatMap((prov) => prov.provided_by ?? []).map(providerLabel)
  )
  const contributor = contributorSummary(model)
  const commentCount = model.comments?.length ?? 0
  const links = modelLinks(model)
  const hasDetailLine = providers.length > 0 || groups.length > 0 || contributor !== null
  const workspaceEntries = workspaceModels.map((workspaceModel) => ({
    id: shortModelId(workspaceModel),
    model: workspaceModel,
    removable: shortModelId(workspaceModel) !== (anchorModelId ?? shortId),
    focused: shortModelId(workspaceModel) === (focusedModelId ?? shortId),
  }))
  const { data: changes } = useQuery({
    queryKey: ["changes", modelId],
    queryFn: () => fetchModelChanges(modelId),
    enabled: Boolean(modelId),
  })
  const latestAppliedChange = useMemo(
    () =>
      changes?.slice().reverse().find((change) => !isGeneratedChange(change) && change.status === "applied") ?? null,
    [changes]
  )
  const latestRedoableChange = useMemo(() => {
    if (!changes) return null
    const indexById = new Map(changes.map((change, index) => [change.id, index]))
    const redoable = changes.filter(
      (change) =>
        !isGeneratedChange(change) &&
        change.status === "reverted" &&
        Boolean(change.metadata?.redo_available)
    )
    if (redoable.length === 0) return null
    return redoable.reduce((latest, candidate) => {
      if (!latest) return candidate
      const latestIndex = typeof latest.metadata?.reverted_by_change_id === "string"
        ? (indexById.get(latest.metadata.reverted_by_change_id) ?? -1)
        : -1
      const candidateIndex = typeof candidate.metadata?.reverted_by_change_id === "string"
        ? (indexById.get(candidate.metadata.reverted_by_change_id) ?? -1)
        : -1
      return candidateIndex > latestIndex ? candidate : latest
    }, null as ChangeRecord | null)
  }, [changes])

  function invalidateModelQueries() {
    queryClient.invalidateQueries({ queryKey: ["model", modelId] })
    queryClient.invalidateQueries({ queryKey: ["connections", modelId] })
    queryClient.invalidateQueries({ queryKey: ["changes", modelId] })
  }

  const undoMutation = useMutation({
    mutationFn: () => undoLastModelChange(modelId),
    onSuccess: () => {
      invalidateModelQueries()
    },
  })
  const redoMutation = useMutation({
    mutationFn: () => redoLastModelChange(modelId),
    onSuccess: () => {
      invalidateModelQueries()
    },
  })

  return (
    <div className="border-b bg-card px-3 py-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 gap-3">
          <Link to="/">
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>

          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-snug sm:text-base">{model.title}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {bioregistryCurie}
                  </Badge>
                  {taxonLabel && <MetaChip label="Taxon" value={taxonLabel} />}
                  {status && <MetaChip label="Status" value={status} />}
                  {updated && <MetaChip label="Updated" value={updated} />}
                  <MetaChip label="Activities" value={`${model.activities?.length ?? 0}`} />
                  {commentCount > 0 && <MetaChip label="Comments" value={`${commentCount}`} />}
                </div>
              </div>

              {hasDetailLine && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                  {providers.length > 0 && (
                    <DetailItem
                      label="Provided by"
                      value={summarizeList(providers)}
                      title={providers.join(", ")}
                    />
                  )}
                  {groups.length > 0 && (
                    <DetailItem label="Groups" value={summarizeList(groups)} title={groups.join(", ")} />
                  )}
                  {contributor && (
                    <DetailItem
                      label="Contributors"
                      value={contributor.label}
                      title={contributor.title}
                    />
                  )}
                </div>
              )}

              {workspaceEntries.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] font-medium text-muted-foreground">Workspace</span>
                  {workspaceEntries.map((entry) => (
                    <span
                      key={entry.id}
                      className={`
                        inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-1
                        ${entry.focused ? "border-foreground/30 bg-foreground text-background" : "bg-background text-foreground"}
                      `}
                    >
                      <button
                        type="button"
                        className="max-w-44 truncate text-[10px] font-medium"
                        title={entry.model.title}
                        onClick={() => onFocusModel?.(entry.id)}
                      >
                        {entry.model.title}
                      </button>
                      {entry.removable && (
                        <button
                          type="button"
                          className={`
                            rounded-full p-0.5 transition-colors
                            ${entry.focused ? "hover:bg-background/15" : "hover:bg-muted"}
                          `}
                          title={`Remove ${entry.model.title} from workspace`}
                          onClick={() => onRemoveImportedModel?.(entry.id)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col items-start gap-2 xl:items-end">
          <div className="flex flex-wrap items-center gap-1.5 rounded-full border bg-muted/40 p-1">
            <Button
              variant={editMode ? "default" : "secondary"}
              size="default"
              className="h-8 rounded-full px-3 text-xs shadow-sm"
              onClick={onToggleEdit}
            >
              <Pencil className="h-3 w-3 mr-1" />
              {editMode ? "Editing" : "Edit Graph"}
            </Button>

            <Button
              variant="outline"
              size="default"
              className="h-8 rounded-full px-3 text-xs shadow-sm"
              onClick={() => undoMutation.mutate()}
              disabled={!latestAppliedChange || undoMutation.isPending || redoMutation.isPending}
              title={latestAppliedChange ? `Undo: ${latestAppliedChange.summary}` : "No applied changes to undo"}
            >
              {undoMutation.isPending ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Undo2 className="h-3 w-3 mr-1" />
              )}
              Undo
            </Button>

            <Button
              variant="outline"
              size="default"
              className="h-8 rounded-full px-3 text-xs shadow-sm"
              onClick={() => redoMutation.mutate()}
              disabled={!latestRedoableChange || redoMutation.isPending || undoMutation.isPending}
              title={latestRedoableChange ? `Redo: ${latestRedoableChange.summary}` : "No reverted changes to redo"}
            >
              {redoMutation.isPending ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Redo2 className="h-3 w-3 mr-1" />
              )}
              Redo
            </Button>

            <NeighboringModelsSheet
              key={model.id}
              model={model}
              neighboringModels={neighboringModels}
              loading={neighboringModelsLoading}
              errorMessage={neighboringModelsError}
              workspaceModelIds={workspaceEntries.map((entry) => entry.id)}
              focusedModelId={focusedModelId}
              onImportModel={onImportModel}
              onFocusModel={onFocusModel}
              onSelectConnectorGene={onSelectConnectorGene}
            />

            <ModelChangesSheet model={model} />
          </div>

          <div className="flex flex-wrap items-center gap-1.5 xl:justify-end">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                title={link.title}
                className="inline-flex h-7 items-center gap-1 rounded-full border bg-background px-2.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <span>{link.label}</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
