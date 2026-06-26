import type { ProcessColor } from "@/lib/colors"
import { EDGE_COLORS, MOLECULE_FLOW_COLOR } from "@/lib/colors"

interface Props {
  processColors: Map<string, ProcessColor>
  processLabels: Map<string, string>
}

export function ProcessLegend({ processColors, processLabels }: Props) {
  if (processColors.size === 0) return null

  return (
    <div className="absolute top-2 right-2 z-10 bg-card/95 backdrop-blur border rounded-lg shadow-md p-2.5 max-w-56">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
        Biological Process
      </p>
      <div className="space-y-1">
        {[...processColors.entries()].map(([termId, color]) => (
          <div key={termId} className="flex items-center gap-1.5">
            <div
              className="w-3 h-3 rounded-sm border shrink-0"
              style={{ backgroundColor: color.bg, borderColor: color.border }}
            />
            <span className="text-[10px] leading-tight truncate" title={termId}>
              {processLabels.get(termId) ?? termId}
            </span>
          </div>
        ))}
      </div>
      <div className="border-t mt-2 pt-1.5">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
          Edge Type
        </p>
        <div className="space-y-1">
          <EdgeLegendItem color={EDGE_COLORS.positive.stroke} label="Positive regulation" />
          <EdgeLegendItem color={EDGE_COLORS.negative.stroke} label="Negative regulation" />
          <EdgeLegendItem color={EDGE_COLORS.neutral.stroke} label="Other causal" />
          <EdgeLegendItem color={MOLECULE_FLOW_COLOR.stroke} label="Molecule flow" dashed />
        </div>
      </div>
    </div>
  )
}

function EdgeLegendItem({ color, label, dashed = false }: { color: string; label: string; dashed?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-3 flex items-center justify-center">
        <div
          className="w-3 h-0.5 rounded"
          style={
            dashed
              ? { backgroundColor: "transparent", borderTop: `2px dashed ${color}` }
              : { backgroundColor: color }
          }
        />
      </div>
      <span className="text-[10px]">{label}</span>
    </div>
  )
}
