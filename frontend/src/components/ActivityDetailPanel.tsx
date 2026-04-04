import { X } from "lucide-react"
import type { Activity, Association, EvidenceItem, GoCamModel } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"

interface Props {
  activity: Activity
  model: GoCamModel
  onClose: () => void
}

function resolveLabel(termId: string | undefined, model: GoCamModel): string {
  if (!termId) return ""
  const obj = model.objects?.find((o) => o.id === termId)
  return obj?.label ? `${obj.label}` : termId
}

function resolveLabelFull(termId: string | undefined, model: GoCamModel): string {
  if (!termId) return ""
  const obj = model.objects?.find((o) => o.id === termId)
  return obj?.label ? `${obj.label} (${termId})` : termId
}

function EvidenceList({ evidence, model }: { evidence?: EvidenceItem[]; model: GoCamModel }) {
  if (!evidence?.length) return null
  return (
    <div className="space-y-1 mt-1">
      {evidence.map((ev, i) => (
        <div key={i} className="text-[10px] bg-muted/50 rounded px-1.5 py-1 space-y-0.5">
          {ev.term && (
            <span className="text-muted-foreground">
              {resolveLabel(ev.term, model)}
            </span>
          )}
          {ev.reference && (
            <span className="ml-1 font-mono text-primary">{ev.reference}</span>
          )}
          {ev.with_objects && ev.with_objects.length > 0 && (
            <div className="text-muted-foreground">
              with: {ev.with_objects.join(", ")}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function AssociationSection({
  label,
  assoc,
  model,
}: {
  label: string
  assoc?: Association | null
  model: GoCamModel
}) {
  if (!assoc?.term) return null
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className="font-medium text-sm">{resolveLabelFull(assoc.term, model)}</p>
      <EvidenceList evidence={assoc.evidence} model={model} />
    </div>
  )
}

export function ActivityDetailPanel({ activity, model, onClose }: Props) {
  const causal = activity.causal_associations ?? []
  const inputs = [...(activity.has_input ?? []), ...(activity.has_primary_input ?? [])]
  const outputs = [...(activity.has_output ?? []), ...(activity.has_primary_output ?? [])]

  return (
    <div className="w-80 border-l bg-card flex flex-col h-full">
      <div className="p-3 border-b flex items-center justify-between">
        <h3 className="font-semibold text-sm">Activity Details</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 p-3">
        <div className="space-y-4 text-sm">
          <div>
            <p className="text-[10px] text-muted-foreground font-mono mb-1">{activity.id}</p>
          </div>

          <AssociationSection label="Enabled by" assoc={activity.enabled_by} model={model} />
          <AssociationSection label="Molecular Function" assoc={activity.molecular_function} model={model} />
          <AssociationSection label="Biological Process" assoc={activity.part_of} model={model} />
          <AssociationSection label="Cellular Component" assoc={activity.occurs_in} model={model} />

          {inputs.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Inputs</p>
              <ul className="space-y-0.5">
                {inputs.map((inp, i) => (
                  <li key={i}>{resolveLabelFull(inp.term, model)}</li>
                ))}
              </ul>
            </div>
          )}

          {outputs.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Outputs</p>
              <ul className="space-y-0.5">
                {outputs.map((out, i) => (
                  <li key={i}>{resolveLabelFull(out.term, model)}</li>
                ))}
              </ul>
            </div>
          )}

          {causal.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-1">Causal Links</p>
                <ul className="space-y-2">
                  {causal.map((c, i) => {
                    const predLabel = resolveLabel(c.predicate, model) || c.predicate || "?"
                    // Find the downstream activity's gene product for a useful label
                    const downAct = model.activities?.find(
                      (a) => a.id === c.downstream_activity
                    )
                    const downGene = downAct?.enabled_by?.term
                    const downLabel = resolveLabel(downGene, model) || c.downstream_activity || ""
                    return (
                      <li key={i}>
                        <div className="flex items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            {predLabel}
                          </Badge>
                          <span className="text-xs truncate">{downLabel}</span>
                        </div>
                        <EvidenceList evidence={c.evidence} model={model} />
                      </li>
                    )
                  })}
                </ul>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
