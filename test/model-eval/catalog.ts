const catalogUrl = "https://opencode.ai/zen/v1/models";

// This intentionally small allowlist is the reviewed tokenless Zen surface. Order is policy:
// prefer Nemotron for tool use, then use MiMo as the single provider-level fallback.
export const freeModelAllowlist = ["nemotron-3.5-lightning-free", "mimo-v2.5-free"] as const;

export interface ModelSelection {
  readonly available: readonly string[];
  readonly selected: readonly string[];
}

function modelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null)
    throw new Error("model catalog is not an object");
  const data = Reflect.get(payload, "data");
  if (!Array.isArray(data)) throw new Error("model catalog has no data array");
  const ids = data.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (typeof item !== "object" || item === null) return [];
    const id = Reflect.get(item, "id");
    return typeof id === "string" ? [id] : [];
  });
  return [...new Set(ids)].sort();
}

function normalizedId(id: string): string {
  return id.startsWith("opencode/") ? id.slice("opencode/".length) : id;
}

export function selectModels(payload: unknown, override?: string): ModelSelection {
  const available = modelIds(payload);
  const availableNormalized = new Set(available.map(normalizedId));
  if (override !== undefined) {
    const candidate = normalizedId(override.trim());
    if (!freeModelAllowlist.includes(candidate as (typeof freeModelAllowlist)[number])) {
      throw new Error("OPENCODE_FREE_MODEL is not in the reviewed free-model allowlist");
    }
    if (!availableNormalized.has(candidate)) {
      throw new Error("OPENCODE_FREE_MODEL is no longer present in the Zen catalog");
    }
    return { available, selected: [candidate] };
  }
  return {
    available,
    selected: freeModelAllowlist.filter((id) => availableNormalized.has(id)),
  };
}

export async function discoverModels(fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher(catalogUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`model catalog returned HTTP ${response.status}`);
  return response.json();
}
