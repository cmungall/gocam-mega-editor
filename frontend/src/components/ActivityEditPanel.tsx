import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { X, Save, Plus, Trash2, Loader2 } from "lucide-react"
import {
  updateActivity,
  type Activity,
  type GoCamModel,
  type ActivityUpdatePayload,
  type EvidenceItem,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"

interface Props {
  activity: Activity
  model: GoCamModel
  onClose: () => void
  onSaved: () => void
}

function resolveLabel(termId: string | undefined, model: GoCamModel): string {
  if (!termId) return ""
  const obj = model.objects?.find((o) => o.id === termId)
  return obj?.label ?? termId
}

interface EvidenceRow {
  term: string
  reference: string
}

export function ActivityEditPanel({ activity, model, onClose, onSaved }: Props) {
  const queryClient = useQueryClient()
  const modelId = model.id.replace("gomodel:", "")

  const [enabledBy, setEnabledBy] = useState(activity.enabled_by?.term ?? "")
  const [mf, setMf] = useState(activity.molecular_function?.term ?? "")
  const [bp, setBp] = useState(activity.part_of?.term ?? "")
  const [cc, setCc] = useState(activity.occurs_in?.term ?? "")

  // Evidence rows from existing data
  const existingEvidence: EvidenceRow[] = (activity.enabled_by?.evidence ?? []).map(
    (ev: EvidenceItem) => ({
      term: ev.term ?? "",
      reference: ev.reference ?? "",
    })
  )
  const [evidence, setEvidence] = useState<EvidenceRow[]>(
    existingEvidence.length > 0 ? existingEvidence : [{ term: "", reference: "" }]
  )

  const mutation = useMutation({
    mutationFn: (payload: ActivityUpdatePayload) =>
      updateActivity(modelId, activity.id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model", modelId] })
      onSaved()
    },
  })

  function handleSave() {
    const payload: ActivityUpdatePayload = {}
    if (enabledBy !== (activity.enabled_by?.term ?? "")) {
      payload.enabled_by_term = enabledBy
    }
    if (mf !== (activity.molecular_function?.term ?? "")) {
      payload.molecular_function_term = mf
    }
    if (bp !== (activity.part_of?.term ?? "")) {
      payload.biological_process_term = bp
    }
    if (cc !== (activity.occurs_in?.term ?? "")) {
      payload.occurs_in_term = cc
    }
    const validEvidence = evidence.filter((e) => e.term || e.reference)
    if (validEvidence.length > 0) {
      payload.evidence = validEvidence.map((e) => ({
        term: e.term || undefined,
        reference: e.reference || undefined,
      }))
    }
    mutation.mutate(payload)
  }

  function addEvidenceRow() {
    setEvidence([...evidence, { term: "", reference: "" }])
  }

  function removeEvidenceRow(idx: number) {
    setEvidence(evidence.filter((_, i) => i !== idx))
  }

  function updateEvidenceRow(idx: number, field: keyof EvidenceRow, value: string) {
    setEvidence(evidence.map((row, i) => (i === idx ? { ...row, [field]: value } : row)))
  }

  const causal = activity.causal_associations ?? []

  return (
    <div className="w-80 border-l bg-card flex flex-col h-full">
      <div className="p-3 border-b flex items-center justify-between">
        <h3 className="font-semibold text-sm">Edit Activity</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 p-3">
        <div className="space-y-4 text-sm">
          <p className="text-[10px] text-muted-foreground font-mono">{activity.id}</p>

          <FieldRow label="Gene Product (enabled_by)" hint="e.g. UniProtKB:P12345">
            <Input
              value={enabledBy}
              onChange={(e) => setEnabledBy(e.target.value)}
              className="h-8 text-xs"
              placeholder="UniProtKB:P12345"
            />
            {enabledBy && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {resolveLabel(enabledBy, model)}
              </p>
            )}
          </FieldRow>

          <FieldRow label="Molecular Function" hint="GO term ID">
            <Input
              value={mf}
              onChange={(e) => setMf(e.target.value)}
              className="h-8 text-xs"
              placeholder="GO:0003674"
            />
            {mf && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {resolveLabel(mf, model)}
              </p>
            )}
          </FieldRow>

          <FieldRow label="Biological Process" hint="GO term ID">
            <Input
              value={bp}
              onChange={(e) => setBp(e.target.value)}
              className="h-8 text-xs"
              placeholder="GO:0008150"
            />
            {bp && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {resolveLabel(bp, model)}
              </p>
            )}
          </FieldRow>

          <FieldRow label="Cellular Component" hint="GO term ID">
            <Input
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              className="h-8 text-xs"
              placeholder="GO:0005575"
            />
            {cc && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {resolveLabel(cc, model)}
              </p>
            )}
          </FieldRow>

          <Separator />

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-semibold">Evidence</Label>
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={addEvidenceRow}>
                <Plus className="h-3 w-3 mr-1" /> Add
              </Button>
            </div>
            <div className="space-y-2">
              {evidence.map((row, i) => (
                <div key={i} className="flex gap-1.5 items-start">
                  <div className="flex-1 space-y-1">
                    <Input
                      value={row.term}
                      onChange={(e) => updateEvidenceRow(i, "term", e.target.value)}
                      className="h-7 text-[10px]"
                      placeholder="ECO:0000314"
                    />
                    <Input
                      value={row.reference}
                      onChange={(e) => updateEvidenceRow(i, "reference", e.target.value)}
                      className="h-7 text-[10px]"
                      placeholder="PMID:12345678"
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => removeEvidenceRow(i)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {causal.length > 0 && (
            <>
              <Separator />
              <div>
                <Label className="text-xs font-semibold">Causal Links</Label>
                <ul className="space-y-1 mt-1">
                  {causal.map((c, i) => {
                    const predLabel = resolveLabel(c.predicate, model) || c.predicate || "?"
                    const downGene = model.activities?.find(
                      (a) => a.id === c.downstream_activity
                    )?.enabled_by?.term
                    return (
                      <li key={i} className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {predLabel}
                        </Badge>
                        <span className="text-xs truncate">
                          {resolveLabel(downGene, model) || c.downstream_activity}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </>
          )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t">
        {mutation.error && (
          <p className="text-destructive text-[10px] mb-2">
            {(mutation.error as Error).message}
          </p>
        )}
        {mutation.isSuccess && (
          <p className="text-green-600 text-[10px] mb-2">Saved successfully</p>
        )}
        <Button onClick={handleSave} disabled={mutation.isPending} className="w-full h-8 text-xs">
          {mutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <Save className="h-3 w-3 mr-1" />
          )}
          Save Changes
        </Button>
      </div>
    </div>
  )
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <Label className="text-xs font-semibold">{label}</Label>
      {hint && <p className="text-[10px] text-muted-foreground mb-1">{hint}</p>}
      {children}
    </div>
  )
}
