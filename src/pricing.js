// Model catalogue + per-request cost estimation, from Orbio's PUBLIC models endpoint.
// No key required to read prices — the key is only needed to actually run inference.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MODELS_URL = "https://www.orbio.so/api/v1/models";
const CACHE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "models.cache.json");

async function fetchCatalogue() {
  try {
    const res = await fetch(MODELS_URL, {
      headers: { "user-agent": "orbio-mesh" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`models HTTP ${res.status}`);
    const j = await res.json();
    try { await mkdir(dirname(CACHE), { recursive: true });
          await writeFile(CACHE, JSON.stringify(j)); } catch {}
    return j;
  } catch (e) {
    // network hiccup: fall back to the last-known catalogue so the mesh stays up
    const cached = JSON.parse(await readFile(CACHE, "utf8"));
    console.error(`[pricing] live catalogue unavailable (${e.message}); using cache`);
    return cached;
  }
}

let _cache = null;
export async function loadModels() {
  if (_cache) return _cache;
  const j = await fetchCatalogue();
  const map = new Map();
  for (const m of j.data ?? []) {
    const prompt = Number(m.pricing?.prompt ?? 0);
    const completion = Number(m.pricing?.completion ?? 0);
    map.set(m.id, {
      id: m.id,
      name: m.name,
      promptUsdPerTok: prompt,
      completionUsdPerTok: completion,
      blendedUsdPerTok: prompt + completion,
      outputModalities: m.architecture?.output_modalities ?? ["text"],
      contextLength: m.context_length,
    });
  }
  _cache = map;
  return map;
}

// Worst-case cost of a request, used to RESERVE budget before dispatch.
// We don't know completion length up front, so we bound it by maxTokens.
export async function estimateMaxCost({ model, promptTokens, maxTokens }) {
  const models = await loadModels();
  const m = models.get(model);
  if (!m) throw new Error(`unknown model: ${model}`);
  return promptTokens * m.promptUsdPerTok + maxTokens * m.completionUsdPerTok;
}

// Actual cost once we know real usage (from the response's usage block).
export async function actualCost({ model, promptTokens, completionTokens }) {
  const models = await loadModels();
  const m = models.get(model);
  if (!m) throw new Error(`unknown model: ${model}`);
  return promptTokens * m.promptUsdPerTok + completionTokens * m.completionUsdPerTok;
}
