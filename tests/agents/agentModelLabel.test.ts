import { describe, expect, it } from "vitest";
import { modelInfo } from "@/lib/agentModelLabel";

describe("modelInfo", () => {
  it("labels every known model id", () => {
    expect(modelInfo("muse-wonder-1.0")).toEqual({ id: "muse-wonder-1.0", label: "Muse Wonder 1.0", provider: "Meta", kind: "text" });
    expect(modelInfo("muse-spark-1.3")).toEqual({ id: "muse-spark-1.3", label: "Muse Spark 1.3", provider: "Meta", kind: "text" });
    expect(modelInfo("muse-spark-1.3-contributor")).toEqual({ id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 (contributor)", provider: "Meta", kind: "text" });
    expect(modelInfo("muse-spark-1.2")).toEqual({ id: "muse-spark-1.2", label: "Muse Spark 1.2", provider: "Meta", kind: "text" });
    expect(modelInfo("muse-spark-open-1026")).toEqual({ id: "muse-spark-open-1026", label: "Muse Spark Open", provider: "Meta", kind: "text" });
    expect(modelInfo("meta-models/muse-spark-open-1026")).toEqual({ id: "meta-models/muse-spark-open-1026", label: "Muse Spark Open", provider: "Meta", kind: "text" });
    expect(modelInfo("muse-glimmer")).toEqual({ id: "muse-glimmer", label: "Muse Glimmer", provider: "Meta", kind: "text" });
    expect(modelInfo("muse-voice-transcribe-1.0")).toEqual({ id: "muse-voice-transcribe-1.0", label: "Muse Voice Transcribe 1.0", provider: "Meta", kind: "voice" });
  });

  it("passes unknown ids through with no provider", () => {
    expect(modelInfo("some-other-model")).toEqual({ id: "some-other-model", label: "some-other-model", provider: null, kind: "unknown" });
  });

  it("reports null and empty ids as an unknown model", () => {
    const unknown = { id: "", label: "Unknown model", provider: null, kind: "unknown" };
    expect(modelInfo(null)).toEqual(unknown);
    expect(modelInfo(undefined)).toEqual(unknown);
    expect(modelInfo("")).toEqual(unknown);
  });
});
