/** API client for the GO-CAM Mega Editor backend. */

export interface ModelSummary {
  id: string
  title: string
  taxon: string | null
  status: string | null
  date: string | null
  contributors: string[]
  groups: string[]
  activity_count: number
}

export interface GraphNode {
  id: string
  label: string | null
  gene_product: string | null
  model_id: string | null
}

export interface GraphEdge {
  source: string
  target: string
  causal_predicate: string | string[] | null
  model_id: string | string[] | null
}

export interface MegaGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  model_count: number
  node_count: number
  edge_count: number
}

export interface EvidenceItem {
  term?: string
  reference?: string
  with_objects?: string[]
  provenances?: { contributor?: string[]; date?: string; provided_by?: string[] }[]
}

export interface Association {
  type?: string
  term?: string
  evidence?: EvidenceItem[]
}

export interface CausalAssociation extends Association {
  predicate?: string
  downstream_activity?: string
}

export interface Activity {
  id: string
  enabled_by?: Association | null
  molecular_function?: Association | null
  part_of?: Association | null
  occurs_in?: Association | null
  causal_associations?: CausalAssociation[]
  has_input?: Association[]
  has_output?: Association[]
  has_primary_input?: Association[]
  has_primary_output?: Association[]
}

export interface GoCamObject {
  id: string
  label?: string
  type?: string
}

export interface GoCamModel {
  id: string
  title: string
  taxon?: string | null
  status?: string | null
  date_modified?: string | null
  comments?: string[]
  activities?: Activity[]
  objects?: GoCamObject[]
  provenances?: { contributor?: string[]; date?: string; provided_by?: string[] }[]
}

const BASE = "/api"

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
  return resp.json() as Promise<T>
}

export function fetchModels(limit = 100, offset = 0): Promise<ModelSummary[]> {
  return fetchJson(`${BASE}/models?limit=${limit}&offset=${offset}`)
}

export function fetchModel(id: string): Promise<GoCamModel> {
  return fetchJson(`${BASE}/model/${id}`)
}

export function fetchGraph(modelIds: string[]): Promise<MegaGraph> {
  const params = modelIds.map((id) => `model_id=${encodeURIComponent(id)}`).join("&")
  return fetchJson(`${BASE}/graph?${params}`)
}
