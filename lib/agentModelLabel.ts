// Human labels for the model ids that runs report.
export interface ModelInfo { id: string; label: string; provider: "Meta" | null; kind: "text" | "voice" | "unknown" }

const KNOWN = new Map<string, { label: string; kind: ModelInfo["kind"] }>([
  ["muse-wonder-1.0", { label: "Muse Wonder 1.0", kind: "text" }],
  ["muse-spark-1.3", { label: "Muse Spark 1.3", kind: "text" }],
  ["muse-spark-1.3-contributor", { label: "Muse Spark 1.3 (contributor)", kind: "text" }],
  ["muse-spark-1.2", { label: "Muse Spark 1.2", kind: "text" }],
  ["muse-spark-open-1026", { label: "Muse Spark Open", kind: "text" }],
  ["meta-models/muse-spark-open-1026", { label: "Muse Spark Open", kind: "text" }],
  ["muse-glimmer", { label: "Muse Glimmer", kind: "text" }],
  ["muse-voice-transcribe-1.0", { label: "Muse Voice Transcribe 1.0", kind: "voice" }],
]);

export function modelInfo(id: string | null | undefined): ModelInfo {
  if (!id) return { id: "", label: "Unknown model", provider: null, kind: "unknown" };
  const known = KNOWN.get(id);
  if (!known) return { id, label: id, provider: null, kind: "unknown" };
  return { id, label: known.label, provider: "Meta", kind: known.kind };
}
