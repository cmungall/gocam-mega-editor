import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { createCausalEdge, fetchPredicates, type GoCamModel } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface Props {
  open: boolean
  sourceActivityId: string
  targetActivityId: string
  model: GoCamModel
  onClose: () => void
  onCreated: () => void
}

function resolveLabel(termId: string | undefined, model: GoCamModel): string {
  if (!termId) return termId ?? ""
  const obj = model.objects?.find((o) => o.id === termId)
  return obj?.label ?? termId
}

export function NewEdgeDialog({
  open,
  sourceActivityId,
  targetActivityId,
  model,
  onClose,
  onCreated,
}: Props) {
  const queryClient = useQueryClient()
  const modelId = model.id.replace("gomodel:", "")
  const [predicate, setPredicate] = useState("")

  const { data: predicates } = useQuery({
    queryKey: ["predicates"],
    queryFn: fetchPredicates,
  })

  const mutation = useMutation({
    mutationFn: () =>
      createCausalEdge(modelId, {
        source_activity_id: sourceActivityId,
        target_activity_id: targetActivityId,
        predicate,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model", modelId] })
      queryClient.invalidateQueries({ queryKey: ["changes", modelId] })
      onCreated()
      onClose()
    },
  })

  const sourceGene = model.activities?.find((a) => a.id === sourceActivityId)?.enabled_by?.term
  const targetGene = model.activities?.find((a) => a.id === targetActivityId)?.enabled_by?.term

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Causal Edge</DialogTitle>
          <DialogDescription>
            Connect two activities with a causal relationship
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center gap-3 text-sm">
            <div className="flex-1 rounded border p-2 text-center">
              <p className="font-medium text-xs">{resolveLabel(sourceGene, model)}</p>
              <p className="text-[10px] text-muted-foreground">Source</p>
            </div>
            <span className="text-muted-foreground">→</span>
            <div className="flex-1 rounded border p-2 text-center">
              <p className="font-medium text-xs">{resolveLabel(targetGene, model)}</p>
              <p className="text-[10px] text-muted-foreground">Target</p>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium mb-1 block">Relationship Type</label>
            <Select value={predicate} onValueChange={(value) => setPredicate(value ?? "")}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Select a causal predicate..." />
              </SelectTrigger>
              <SelectContent>
                {predicates &&
                  Object.entries(predicates).map(([id, label]) => (
                    <SelectItem key={id} value={id} className="text-xs">
                      {label} ({id})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {mutation.error && (
            <p className="text-destructive text-xs">{(mutation.error as Error).message}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="text-xs h-8">
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!predicate || mutation.isPending}
            className="text-xs h-8"
          >
            {mutation.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
            Create Edge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
