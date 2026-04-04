/** Color palette for biological process grouping and edge styling. */

// Distinct, colorblind-friendly palette for biological processes
const BP_PALETTE = [
  { bg: "#dbeafe", border: "#3b82f6", text: "#1e40af" },  // blue
  { bg: "#dcfce7", border: "#22c55e", text: "#166534" },  // green
  { bg: "#fef3c7", border: "#f59e0b", text: "#92400e" },  // amber
  { bg: "#fce7f3", border: "#ec4899", text: "#9d174d" },  // pink
  { bg: "#e0e7ff", border: "#6366f1", text: "#3730a3" },  // indigo
  { bg: "#ffedd5", border: "#f97316", text: "#9a3412" },  // orange
  { bg: "#f0fdf4", border: "#4ade80", text: "#15803d" },  // emerald
  { bg: "#ede9fe", border: "#8b5cf6", text: "#5b21b6" },  // violet
  { bg: "#fef9c3", border: "#eab308", text: "#854d0e" },  // yellow
  { bg: "#e0f2fe", border: "#0ea5e9", text: "#0c4a6e" },  // sky
  { bg: "#fae8ff", border: "#d946ef", text: "#86198f" },  // fuchsia
  { bg: "#ccfbf1", border: "#14b8a6", text: "#134e4a" },  // teal
] as const

const FALLBACK = { bg: "#f5f5f5", border: "#a3a3a3", text: "#525252" }

export type ProcessColor = { bg: string; border: string; text: string }

/**
 * Build a mapping from biological process term to color.
 * Each unique BP gets a distinct color from the palette.
 */
export function buildProcessColorMap(
  bpTerms: (string | undefined)[]
): Map<string, ProcessColor> {
  const unique = [...new Set(bpTerms.filter((t): t is string => !!t))]
  const map = new Map<string, ProcessColor>()
  unique.forEach((term, i) => {
    map.set(term, BP_PALETTE[i % BP_PALETTE.length])
  })
  return map
}

export function getProcessColor(
  term: string | undefined,
  colorMap: Map<string, ProcessColor>
): ProcessColor {
  if (!term) return FALLBACK
  return colorMap.get(term) ?? FALLBACK
}

// Edge colors by regulation type
export const EDGE_COLORS = {
  positive: { stroke: "#22c55e", label: "#166534" },     // green
  negative: { stroke: "#ef4444", label: "#991b1b" },     // red
  neutral: { stroke: "#94a3b8", label: "#475569" },      // slate
} as const

/** Classify a causal predicate into positive/negative/neutral */
export function classifyPredicate(predicate: string | undefined): keyof typeof EDGE_COLORS {
  if (!predicate) return "neutral"
  const p = predicate.toLowerCase()
  if (
    p.includes("positively") ||
    p.includes("activates") ||
    p === "ro:0002629" ||
    p === "ro:0002406" ||
    p === "ro:0002304" ||
    p === "ro:0002213"
  ) return "positive"
  if (
    p.includes("negatively") ||
    p.includes("inhibits") ||
    p === "ro:0002630" ||
    p === "ro:0002408" ||
    p === "ro:0002305" ||
    p === "ro:0002212"
  ) return "negative"
  return "neutral"
}
