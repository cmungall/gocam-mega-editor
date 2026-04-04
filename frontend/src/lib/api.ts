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

export interface SharedGene {
  gene_id: string
  label: string | null
  model_ids: string[]
}

export interface ModelNode {
  id: string
  title: string
  taxon: string | null
  activity_count: number
}

export interface ModelEdge {
  source: string
  target: string
  shared_genes: SharedGene[]
  weight: number
}

export interface SpeciesCluster {
  taxon: string | null
  taxon_label: string | null
  models: ModelNode[]
  edges: ModelEdge[]
}

export interface ConnectedModelsResult {
  species_clusters: SpeciesCluster[]
  total_models: number
  total_connections: number
}

export function fetchConnectedModels(modelIds?: string[]): Promise<ConnectedModelsResult> {
  const params = modelIds?.map((id) => `model_id=${encodeURIComponent(id)}`).join("&")
  return fetchJson(`${BASE}/connected-models${params ? `?${params}` : ""}`)
}

export function fetchPredicates(): Promise<Record<string, string>> {
  return fetchJson(`${BASE}/predicates`)
}

// --- Mutations ---

export interface ActivityUpdatePayload {
  enabled_by_term?: string
  molecular_function_term?: string
  biological_process_term?: string
  occurs_in_term?: string
  evidence?: { term?: string; reference?: string; with_objects?: string[] }[]
}

export interface CausalEdgePayload {
  source_activity_id: string
  target_activity_id: string
  predicate: string
}

async function mutateJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!resp.ok) {
    const detail = await resp.text()
    throw new Error(`${resp.status}: ${detail}`)
  }
  return resp.json() as Promise<T>
}

export function updateActivity(
  modelId: string,
  activityId: string,
  payload: ActivityUpdatePayload,
): Promise<Activity> {
  return mutateJson(`${BASE}/model/${modelId}/activity/${activityId}`, "PATCH", payload)
}

export function createCausalEdge(modelId: string, payload: CausalEdgePayload): Promise<CausalAssociation> {
  return mutateJson(`${BASE}/model/${modelId}/causal-edge`, "POST", payload)
}

export function deleteCausalEdge(
  modelId: string,
  sourceActivityId: string,
  targetActivityId: string,
): Promise<void> {
  const params = new URLSearchParams({
    source_activity_id: sourceActivityId,
    target_activity_id: targetActivityId,
  })
  return mutateJson(`${BASE}/model/${modelId}/causal-edge?${params}`, "DELETE")
}
