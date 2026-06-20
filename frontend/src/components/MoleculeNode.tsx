import { memo } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"

export interface MoleculeNodeData {
  label: string
  term: string
  location?: string
  modelId?: string
  borderColor: string
  [key: string]: unknown
}

export const MoleculeNode = memo(function MoleculeNode({ data }: NodeProps) {
  const d = data as unknown as MoleculeNodeData
  const title = [d.label, d.term, d.location].filter(Boolean).join(" · ")

  return (
    <div
      className="relative w-44 rounded-md border bg-teal-50 px-2.5 py-1.5 text-teal-950 shadow-sm"
      title={title}
      style={{ borderColor: d.borderColor }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!h-2.5 !w-2.5 !-left-1.5 !border !border-background"
        style={{ backgroundColor: d.borderColor }}
      />
      <p className="truncate text-[10px] font-semibold leading-tight">{d.label || d.term}</p>
      {d.location ? (
        <p className="mt-0.5 truncate text-[9px] leading-tight text-teal-800">{d.location}</p>
      ) : (
        <p className="mt-0.5 truncate text-[9px] leading-tight text-teal-800">{d.term}</p>
      )}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!-right-1.5 !h-2.5 !w-2.5 !border !border-background"
        style={{ backgroundColor: d.borderColor }}
      />
    </div>
  )
})
