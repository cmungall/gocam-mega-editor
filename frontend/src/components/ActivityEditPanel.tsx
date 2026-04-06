import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { X, Save, Plus, Trash2, Loader2 } from "lucide-react"
import {
  updateActivity,
  deleteCausalEdge,
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
import { TermAutocomplete } from "./TermAutocomplete"

interface Props {
  activity: Activity
  model: GoCamModel
  onClose: () => void
  onSaved: () => void
}

function resolveLabel(termId: string | undefined, model: GoCamModel): string {
  if (!termId) return ""
  const obj = model.objects?.find((o) => o.id === termId)
  return obj?.label ?? ""
}

function normalizeLabel(id: string, label: string): string {
  return label && label !== id ? label : ""
}

interface TermValue {
  term: string
  label: string
}

interface EvidenceRow {
  term: string
  termLabel: string
  reference: string
  withObjects: string
}

function termValueFromId(termId: string | undefined, model: GoCamModel): TermValue {
  return {
    term: termId ?? "",
    label: normalizeLabel(termId ?? "", resolveLabel(termId, model)),
  }
}

function evidenceRowsFromItems(evidence: EvidenceItem[] | undefined, model: GoCamModel): EvidenceRow[] {
  if (!evidence?.length) {
    return [{ term: "", termLabel: "", reference: "", withObjects: "" }]
  }
  return evidence.map((ev) => ({
    term: ev.term ?? "",
    termLabel: normalizeLabel(ev.term ?? "", ev.term_label ?? resolveLabel(ev.term, model)),
    reference: ev.reference ?? "",
    withObjects: (ev.with_objects ?? []).join(", "),
  }))
}

function resolveActivityEvidence(activity: Activity, model: GoCamModel): EvidenceRow[] {
  const sharedEvidence = [
    activity.enabled_by?.evidence,
    activity.molecular_function?.evidence,
    activity.part_of?.evidence,
    activity.occurs_in?.evidence,
  ].find((evidence) => evidence && evidence.length > 0)

  return evidenceRowsFromItems(sharedEvidence, model)
}

function normalizeEvidenceRows(rows: EvidenceRow[]): EvidenceRow[] {
  return rows
    .map((row) => ({
      term: row.term.trim(),
      termLabel: normalizeLabel(row.term.trim(), row.termLabel.trim()),
      reference: row.reference.trim(),
      withObjects: row.withObjects
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .join(", "),
    }))
    .filter((row) => row.term || row.reference || row.withObjects)
}

function evidenceRowsEqual(a: EvidenceRow[], b: EvidenceRow[]): boolean {
  return JSON.stringify(normalizeEvidenceRows(a)) === JSON.stringify(normalizeEvidenceRows(b))
}

export function ActivityEditPanel({ activity, model, onClose, onSaved }: Props) {
  const queryClient = useQueryClient()
  const modelId = model.id.replace("gomodel:", "")
  const baselineEnabledBy = termValueFromId(activity.enabled_by?.term, model)
  const baselineMf = termValueFromId(activity.molecular_function?.term, model)
  const baselineBp = termValueFromId(activity.part_of?.term, model)
  const baselineCc = termValueFromId(activity.occurs_in?.term, model)

  const [enabledBy, setEnabledBy] = useState<TermValue>(() => baselineEnabledBy)
  const [mf, setMf] = useState<TermValue>(() => baselineMf)
  const [bp, setBp] = useState<TermValue>(() => baselineBp)
  const [cc, setCc] = useState<TermValue>(() => baselineCc)
  const [evidence, setEvidence] = useState<EvidenceRow[]>(() => resolveActivityEvidence(activity, model))

  function invalidateModelQueries() {
    queryClient.invalidateQueries({ queryKey: ["model", modelId] })
    queryClient.invalidateQueries({ queryKey: ["connections", modelId] })
    queryClient.invalidateQueries({ queryKey: ["changes", modelId] })
  }

  const mutation = useMutation({
    mutationFn: (payload: ActivityUpdatePayload) =>
      updateActivity(modelId, activity.id, payload),
    onSuccess: () => {
      invalidateModelQueries()
      onSaved()
    },
  })

  const deleteEdgeMutation = useMutation({
    mutationFn: ({
      targetActivityId,
      predicate,
    }: {
      targetActivityId: string
      predicate?: string
    }) => deleteCausalEdge(modelId, activity.id, targetActivityId, predicate),
    onSuccess: () => {
      invalidateModelQueries()
      onSaved()
    },
  })

  const baselineEvidence = resolveActivityEvidence(activity, model)
  const hasChanges =
    enabledBy.term !== baselineEnabledBy.term ||
    enabledBy.label !== baselineEnabledBy.label ||
    mf.term !== baselineMf.term ||
    mf.label !== baselineMf.label ||
    bp.term !== baselineBp.term ||
    bp.label !== baselineBp.label ||
    cc.term !== baselineCc.term ||
    cc.label !== baselineCc.label ||
    !evidenceRowsEqual(evidence, baselineEvidence)

  function handleSave() {
    const payload: ActivityUpdatePayload = {}
    if (enabledBy.term !== baselineEnabledBy.term || enabledBy.label !== baselineEnabledBy.label) {
      payload.enabled_by_term = enabledBy.term
      payload.enabled_by_label = enabledBy.label || undefined
    }
    if (mf.term !== baselineMf.term || mf.label !== baselineMf.label) {
      payload.molecular_function_term = mf.term
      payload.molecular_function_label = mf.label || undefined
    }
    if (bp.term !== baselineBp.term || bp.label !== baselineBp.label) {
      payload.biological_process_term = bp.term
      payload.biological_process_label = bp.label || undefined
    }
    if (cc.term !== baselineCc.term || cc.label !== baselineCc.label) {
      payload.occurs_in_term = cc.term
      payload.occurs_in_label = cc.label || undefined
    }
    if (!evidenceRowsEqual(evidence, baselineEvidence)) {
      payload.evidence = normalizeEvidenceRows(evidence).map((row) => ({
        term: row.term || undefined,
        term_label: row.termLabel || undefined,
        reference: row.reference || undefined,
        with_objects: row.withObjects ? row.withObjects.split(",").map((value) => value.trim()) : undefined,
      }))
    }
    if (Object.keys(payload).length === 0) {
      return
    }
    mutation.mutate(payload)
  }

  function addEvidenceRow() {
    setEvidence([...evidence, { term: "", termLabel: "", reference: "", withObjects: "" }])
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

          <FieldRow label="Gene Product (enabled_by)" hint="Search by gene name">
            <TermAutocomplete
              field="enabled_by"
              value={enabledBy.term}
              valueLabel={enabledBy.label}
              taxon={model.taxon}
              placeholder="Search gene products..."
              onChange={(id, label) => setEnabledBy({ term: id, label: normalizeLabel(id, label) })}
            />
          </FieldRow>

          <FieldRow label="Molecular Function" hint="Search GO molecular functions">
            <TermAutocomplete
              field="molecular_function"
              value={mf.term}
              valueLabel={mf.label}
              placeholder="Search e.g. kinase activity..."
              onChange={(id, label) => setMf({ term: id, label: normalizeLabel(id, label) })}
            />
          </FieldRow>

          <FieldRow label="Biological Process" hint="Search GO biological processes">
            <TermAutocomplete
              field="biological_process"
              value={bp.term}
              valueLabel={bp.label}
              placeholder="Search e.g. apoptosis..."
              onChange={(id, label) => setBp({ term: id, label: normalizeLabel(id, label) })}
            />
          </FieldRow>

          <FieldRow label="Cellular Component" hint="Search GO cellular components">
            <TermAutocomplete
              field="occurs_in"
              value={cc.term}
              valueLabel={cc.label}
              placeholder="Search e.g. nucleus..."
              onChange={(id, label) => setCc({ term: id, label: normalizeLabel(id, label) })}
            />
          </FieldRow>

          <Separator />

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-semibold">Evidence</Label>
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={addEvidenceRow}>
                <Plus className="h-3 w-3 mr-1" /> Add
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mb-2">
              Shared evidence is applied across the editable activity assertions.
            </p>
            <div className="space-y-2">
              {evidence.map((row, i) => (
                <div key={i} className="flex gap-1.5 items-start">
                  <div className="flex-1 space-y-1">
                    <TermAutocomplete
                      field="evidence"
                      value={row.term}
                      valueLabel={row.termLabel}
                      placeholder="Search evidence codes..."
                      onChange={(id, label) =>
                        setEvidence(
                          evidence.map((evidenceRow, evidenceIndex) =>
                            evidenceIndex === i
                              ? {
                                  ...evidenceRow,
                                  term: id,
                                  termLabel: normalizeLabel(id, label),
                                }
                              : evidenceRow
                          )
                        )
                      }
                    />
                    <Input
                      value={row.reference}
                      onChange={(e) => updateEvidenceRow(i, "reference", e.target.value)}
                      className="h-7 text-[10px]"
                      placeholder="PMID:12345678"
                    />
                    <Input
                      value={row.withObjects}
                      onChange={(e) => updateEvidenceRow(i, "withObjects", e.target.value)}
                      className="h-7 text-[10px]"
                      placeholder="with: UniProtKB:P12345, CHEBI:15377"
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
                    const isDeleting =
                      deleteEdgeMutation.isPending &&
                      deleteEdgeMutation.variables?.targetActivityId === c.downstream_activity &&
                      deleteEdgeMutation.variables?.predicate === c.predicate
                    return (
                      <li key={i} className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {predLabel}
                        </Badge>
                        <span className="text-xs truncate flex-1">
                          {resolveLabel(downGene, model) || c.downstream_activity}
                        </span>
                        {c.downstream_activity && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0"
                            disabled={isDeleting}
                            onClick={() =>
                              deleteEdgeMutation.mutate({
                                targetActivityId: c.downstream_activity!,
                                predicate: c.predicate ?? undefined,
                              })
                            }
                          >
                            {isDeleting ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </Button>
                        )}
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
        {deleteEdgeMutation.error && (
          <p className="text-destructive text-[10px] mb-2">
            {(deleteEdgeMutation.error as Error).message}
          </p>
        )}
        {mutation.isSuccess && (
          <p className="text-green-600 text-[10px] mb-2">Saved successfully</p>
        )}
        <Button
          onClick={handleSave}
          disabled={mutation.isPending || deleteEdgeMutation.isPending || !hasChanges}
          className="w-full h-8 text-xs"
        >
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
