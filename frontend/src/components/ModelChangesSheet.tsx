import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { History, Loader2, RotateCcw } from "lucide-react"

import { fetchModelChanges, revertModelChange, type ChangeRecord, type GoCamModel } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
}

function resolveLabel(termId: string | null | undefined, model: GoCamModel): string {
  if (!termId) return ""
  const obj = model.objects?.find((item) => item.id === termId)
  return obj?.label ?? termId
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed)
}

function activityTail(value: unknown): string {
  if (typeof value !== "string") return "activity"
  return value.split("/").at(-1) ?? value
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function formatTermSnapshot(value: unknown, model: GoCamModel): string {
  const snapshot = asRecord(value)
  const term = typeof snapshot?.term === "string" ? snapshot.term : ""
  if (!term) return "none"
  const snapshotLabel = typeof snapshot?.label === "string" ? snapshot.label : ""
  const resolvedLabel = snapshotLabel || resolveLabel(term, model)
  return resolvedLabel && resolvedLabel !== term ? `${resolvedLabel} (${term})` : term
}

function formatEvidenceItem(value: unknown, model: GoCamModel): string {
  const evidence = asRecord(value)
  const term = typeof evidence?.term === "string" ? evidence.term : ""
  const termLabel =
    typeof evidence?.term_label === "string" && evidence.term_label !== term
      ? evidence.term_label
      : resolveLabel(term, model)
  const reference = typeof evidence?.reference === "string" ? evidence.reference : ""
  const withObjects = Array.isArray(evidence?.with_objects)
    ? evidence.with_objects.filter((item): item is string => typeof item === "string")
    : []
  const parts = [
    term ? (termLabel && termLabel !== term ? `${termLabel} (${term})` : term) : "",
    reference,
    withObjects.length > 0 ? `with ${withObjects.join(", ")}` : "",
  ].filter(Boolean)
  return parts.join(" | ") || "none"
}

function formatEvidencePayload(value: unknown, model: GoCamModel): string {
  const evidence = Array.isArray(asRecord(value)?.evidence)
    ? (asRecord(value)?.evidence as unknown[])
    : []
  if (evidence.length === 0) return "none"
  return evidence.map((item) => formatEvidenceItem(item, model)).join("; ")
}

function changeDetails(change: ChangeRecord, model: GoCamModel): string[] {
  if (change.operation_type.startsWith("set_")) {
    return [
      `${formatTermSnapshot(change.before, model)} -> ${formatTermSnapshot(change.after, model)}`,
      `Target: ${activityTail(change.target.activity_id)}`,
    ]
  }

  if (change.operation_type === "replace_evidence") {
    return [
      `${formatEvidencePayload(change.before, model)} -> ${formatEvidencePayload(change.after, model)}`,
      `Target: ${activityTail(change.target.activity_id)}`,
    ]
  }

  if (change.operation_type.endsWith("_causal_edge")) {
    const predicate =
      typeof change.target.predicate === "string"
        ? resolveLabel(change.target.predicate, model)
        : "predicate"
    return [
      `${activityTail(change.target.source_activity_id)} -> ${activityTail(change.target.target_activity_id)}`,
      `Predicate: ${predicate}`,
    ]
  }

  return []
}

function isGeneratedChange(change: ChangeRecord): boolean {
  const generatedBy = change.metadata?.generated_by
  return generatedBy === "undo" || generatedBy === "redo"
}

function generatedLabel(change: ChangeRecord): string | null {
  const generatedBy = change.metadata?.generated_by
  if (generatedBy === "undo") return "undo"
  if (generatedBy === "redo") return "redo"
  return null
}

export function ModelChangesSheet({ model }: Props) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const modelId = useMemo(() => model.id.replace(/^gomodel:/, ""), [model.id])

  const { data: changes, isLoading } = useQuery({
    queryKey: ["changes", modelId],
    queryFn: () => fetchModelChanges(modelId),
    enabled: Boolean(modelId),
  })

  function invalidateModelQueries() {
    queryClient.invalidateQueries({ queryKey: ["model", modelId] })
    queryClient.invalidateQueries({ queryKey: ["connections", modelId] })
    queryClient.invalidateQueries({ queryKey: ["changes", modelId] })
  }

  const revertMutation = useMutation({
    mutationFn: (changeId: string) => revertModelChange(modelId, changeId),
    onSuccess: () => {
      invalidateModelQueries()
    },
  })

  const count = changes?.length ?? 0

  return (
    <>
      <Button
        variant={open ? "default" : "secondary"}
        size="sm"
        className="h-8 shrink-0 rounded-full px-3 text-xs shadow-sm"
        onClick={() => setOpen(true)}
        title="Open recorded edit history for this model"
      >
        <History className="h-3 w-3 mr-1" />
        Change History
        <span className="ml-1 rounded-full bg-background/80 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
          {count}
        </span>
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>Changes</SheetTitle>
            <SheetDescription>
              Semantic edit history for this model. This is the first step toward undo, review, and agent-authored change sets.
            </SheetDescription>
          </SheetHeader>

          <ScrollArea className="flex-1">
            <div className="p-4 space-y-3">
              {isLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading changes...
                </div>
              )}

              {revertMutation.error && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  {(revertMutation.error as Error).message}
                </div>
              )}

              {!isLoading && count === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No recorded changes yet for this session.
                </div>
              )}

              {(changes ?? []).slice().reverse().map((change) => {
                const details = changeDetails(change, model)
                const generated = isGeneratedChange(change)
                const generatedBadge = generatedLabel(change)
                return (
                  <div key={change.id} className="rounded-xl border bg-card p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium leading-snug">{change.summary}</p>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {formatTimestamp(change.created_at)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {generatedBadge && (
                          <Badge variant="secondary" className="text-[10px]">
                            {generatedBadge}
                          </Badge>
                        )}
                        {change.status !== "applied" && (
                          <Badge variant="secondary" className="text-[10px]">
                            {change.status}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[10px]">
                          {change.operation_type}
                        </Badge>
                      </div>
                    </div>

                    {details.length > 0 && (
                      <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                        {details.map((detail) => (
                          <p key={detail}>{detail}</p>
                        ))}
                      </div>
                    )}

                    <div className="mt-3 flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 rounded-full px-2.5 text-[11px]"
                        disabled={generated || change.status !== "applied" || revertMutation.isPending}
                        onClick={() => revertMutation.mutate(change.id)}
                        title={
                          generated
                            ? "Generated undo/redo entries are controlled by the stack buttons"
                            : change.status === "applied"
                            ? `Revert: ${change.summary}`
                            : "This change has already been reverted"
                        }
                      >
                        {revertMutation.isPending && revertMutation.variables === change.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <RotateCcw className="mr-1 h-3 w-3" />
                        )}
                        {generated ? "Derived" : change.status === "applied" ? "Revert" : "Reverted"}
                      </Button>
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
