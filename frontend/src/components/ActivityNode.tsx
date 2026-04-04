import { memo } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"

export interface ActivityNodeData {
  label: string
  geneProduct: string
  molecularFunction?: string
  biologicalProcess?: string
  cellularComponent?: string
  isExpanded: boolean
  // Process color
  bgColor: string
  borderColor: string
  textColor: string
  [key: string]: unknown
}

export const ActivityNode = memo(function ActivityNode({
  data,
  selected,
}: NodeProps) {
  const d = data as unknown as ActivityNodeData
  const expanded = d.isExpanded

  return (
    <div
      className={`
        rounded-lg border-2 shadow-sm
        transition-all duration-200
        ${selected ? "ring-2 ring-ring ring-offset-1" : ""}
        ${expanded ? "min-w-60" : "min-w-40"}
      `}
      style={{
        backgroundColor: d.bgColor,
        borderColor: d.borderColor,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !-left-[6px]"
        style={{ backgroundColor: d.borderColor }}
      />

      <div className="px-3 py-2">
        <p
          className="text-xs font-bold truncate max-w-52"
          style={{ color: d.textColor }}
        >
          {d.label || d.geneProduct}
        </p>
        {!expanded && d.molecularFunction && (
          <p className="text-[10px] truncate opacity-75" style={{ color: d.textColor }}>
            {d.molecularFunction}
          </p>
        )}
        {!expanded && d.biologicalProcess && (
          <p className="text-[10px] truncate mt-0.5 italic opacity-60" style={{ color: d.textColor }}>
            {d.biologicalProcess}
          </p>
        )}
      </div>

      {expanded && (
        <div
          className="px-3 pb-2.5 space-y-1 pt-1.5"
          style={{ borderTop: `1px solid ${d.borderColor}40` }}
        >
          {d.geneProduct && (
            <Row label="Gene" value={d.geneProduct} color={d.textColor} />
          )}
          {d.molecularFunction && (
            <Row label="MF" value={d.molecularFunction} color={d.textColor} />
          )}
          {d.biologicalProcess && (
            <Row label="BP" value={d.biologicalProcess} color={d.textColor} />
          )}
          {d.cellularComponent && (
            <Row label="CC" value={d.cellularComponent} color={d.textColor} />
          )}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !-right-[6px]"
        style={{ backgroundColor: d.borderColor }}
      />
    </div>
  )
})

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex gap-1.5 text-[10px]">
      <span className="font-semibold shrink-0 opacity-60" style={{ color }}>{label}</span>
      <span className="truncate max-w-44" style={{ color }}>{value}</span>
    </div>
  )
}
