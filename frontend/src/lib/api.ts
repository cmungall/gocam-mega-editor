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
  term_label?: string
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

export interface MoleculeAssociation extends Association {
  predicate?: string
  molecule?: string
}

export interface MoleculeInstance {
  id: string
  term?: string
  located_in?: Association | null
}

export interface Activity {
  id: string
  enabled_by?: Association | null
  molecular_function?: Association | null
  part_of?: Association | null
  occurs_in?: Association | null
  causal_associations?: CausalAssociation[]
  molecular_associations?: MoleculeAssociation[]
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
  molecules?: MoleculeInstance[]
  objects?: GoCamObject[]
  provenances?: { contributor?: string[]; date?: string; provided_by?: string[] }[]
  summary?: ModelSummary
}

export interface ChangeRecord {
  id: string
  model_id: string
  created_at: string
  author_type: string
  author_id?: string | null
  status: string
  operation_type: string
  target: Record<string, unknown>
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  inverse?: Record<string, unknown> | null
  summary: string
  metadata?: Record<string, unknown> | null
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

export function fetchModelChanges(id: string): Promise<ChangeRecord[]> {
  return fetchJson(`${BASE}/model/${id}/changes`)
}

export function revertModelChange(modelId: string, changeId: string): Promise<ChangeRecord> {
  return mutateJson(`${BASE}/model/${modelId}/changes/${changeId}/revert`, "POST")
}

export function undoLastModelChange(modelId: string): Promise<ChangeRecord> {
  return mutateJson(`${BASE}/model/${modelId}/changes/undo`, "POST")
}

export function redoLastModelChange(modelId: string): Promise<ChangeRecord> {
  return mutateJson(`${BASE}/model/${modelId}/changes/redo`, "POST")
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

export interface ModelLinkAnchor {
  source_activity_id?: string | null
  target_activity_id?: string | null
  gene_id?: string | null
  gene_label?: string | null
  molecular_function?: string | null
  biological_process?: string | null
  cellular_component?: string | null
  molecule_id?: string | null
  molecule_label?: string | null
  source_role?: string | null
  target_role?: string | null
}

export interface ModelLinkCriterion {
  type: string
  label: string
  strength: string
  count: number
  direction: "source_to_target" | "target_to_source" | "bidirectional" | null
  anchors: ModelLinkAnchor[]
}

export interface ModelEdge {
  source: string
  target: string
  shared_genes: SharedGene[]
  weight: number
  score?: number
  direction?: "source_to_target" | "target_to_source" | "bidirectional" | "undirected"
  criteria?: ModelLinkCriterion[]
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

export function fetchConnectedModels(
  modelIds?: string[],
  criteria?: string[],
  minScore = 0,
): Promise<ConnectedModelsResult> {
  const params = new URLSearchParams()
  for (const id of modelIds ?? []) {
    params.append("model_id", id)
  }
  for (const criterion of criteria ?? []) {
    params.append("criteria", criterion)
  }
  if (minScore > 0) {
    params.set("min_score", String(minScore))
  }
  const query = params.toString()
  return fetchJson(`${BASE}/connected-models${query ? `?${query}` : ""}`)
}

export interface GeneConnection {
  gene_id: string
  label: string | null
  other_models: ModelSummary[]
}

export interface ModelConnectionsResult {
  model_id: string
  connections: GeneConnection[]
  linked_models?: ModelSummary[]
  model_links?: ModelEdge[]
}

export function fetchModelConnections(modelId: string): Promise<ModelConnectionsResult> {
  return fetchJson(`${BASE}/model/${modelId}/connections`)
}

export interface AutocompleteItem {
  id: string
  label: string
  category: string | null
}

export function autocomplete(
  field: string,
  query: string,
  taxon?: string | null,
  limit = 10,
): Promise<AutocompleteItem[]> {
  return mutateJson(`${BASE}/autocomplete`, "POST", { field, query, taxon, limit })
}

export function fetchPredicates(): Promise<Record<string, string>> {
  return fetchJson(`${BASE}/predicates`)
}

// --- Mutations ---

export interface ActivityUpdatePayload {
  enabled_by_term?: string
  enabled_by_label?: string
  molecular_function_term?: string
  molecular_function_label?: string
  biological_process_term?: string
  biological_process_label?: string
  occurs_in_term?: string
  occurs_in_label?: string
  evidence?: { term?: string; term_label?: string; reference?: string; with_objects?: string[] }[]
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
  predicate?: string,
): Promise<void> {
  const params = new URLSearchParams({
    source_activity_id: sourceActivityId,
    target_activity_id: targetActivityId,
  })
  if (predicate) {
    params.set("predicate", predicate)
  }
  return mutateJson(`${BASE}/model/${modelId}/causal-edge?${params}`, "DELETE")
}
