import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readFleetConfig } from "../../agent/config.mjs";
import { runFleet } from "../../agent/fleet.mjs";
import { createMcpClient } from "../../agent/mcpClient.mjs";

const never = (signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

function harness(lists: (string[] | Error)[]) {
  const controller = new AbortController();
  const stopped: string[] = [];
  const started: string[] = [];
  let tick = 0;
  return {
    started, stopped, controller,
    run: (serve?: (id: string, signal: AbortSignal) => Promise<void>) => runFleet({
      signal: controller.signal,
      listAgents: () => {
        const next = lists[Math.min(tick++, lists.length - 1)];
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
      serve: serve ?? (async (id, signal) => {
        started.push(id);
        await never(signal);
        stopped.push(id);
      }),
      sleep: () => {
        if (tick >= lists.length) controller.abort();
        return Promise.resolve();
      },
    }),
  };
}

describe("runFleet", () => {
  it("keeps one agent per workspace and adds new ones", async () => {
    const fleet = harness([["a"], ["a", "b"], ["a", "b"]]);
    await fleet.run();
    expect(fleet.started).toEqual(["a", "b"]);
    expect(fleet.stopped.sort()).toEqual(["a", "b"]);
  });

  it("stops an agent that is no longer listed", async () => {
    const fleet = harness([["a", "b"], ["b"], ["b"]]);
    await fleet.run();
    expect(fleet.stopped[0]).toBe("a");
  });

  it("restarts an agent that failed and survives a failed list", async () => {
    const runs: string[] = [];
    const fleet = harness([["a"], new Error("offline"), ["a"], ["a"]]);
    await fleet.run(async (id) => {
      runs.push(id);
      await Promise.resolve();
      throw new Error("crashed");
    });
    expect(runs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("readFleetConfig", () => {
  const env = { VITE_SUPABASE_URL: "https://x.supabase.co/", TRAMA_RUNTIME_SECRET: "s", META_MODEL_API_KEY: "k", VITE_APP_URL: "https://app.test" };

  it("refuses to start without the project's secrets", () => {
    expect(() => readFleetConfig({ ...env, TRAMA_RUNTIME_SECRET: "" })).toThrow(/TRAMA_RUNTIME_SECRET/);
    expect(() => readFleetConfig({ ...env, META_MODEL_API_KEY: undefined })).toThrow(/META_MODEL_API_KEY/);
  });

  it("derives every address from the deployment and prices the model", () => {
    const { runtimeUrl, config } = readFleetConfig(env);
    expect(runtimeUrl).toBe("https://x.supabase.co/functions/v1/trama-runtime");
    expect(config.mcpUrl).toBe("https://x.supabase.co/functions/v1/mcp");
    expect(config.appUrl).toBe("https://app.test");
    expect(config.prices).toEqual({ input: 1.25, output: 4.25 });
  });
});

describe("createMcpClient signIn", () => {
  it("uses the runtime's sign-in instead of a PAT", async () => {
    const seen: string[] = [];
    const client = createMcpClient({
      url: "https://x.test/mcp",
      signIn: () => Promise.resolve("runtime-jwt"),
      fetchImpl: ((_url: string, init: RequestInit) => {
        seen.push(String((init.headers as Record<string, string>).Authorization));
        return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } }));
      }) as unknown as typeof fetch,
    });
    await client.initialize();
    expect(seen[0]).toBe("Bearer runtime-jwt");
  });
});

describe("the runtime image", () => {
  it("needs nothing outside agent/, its build context", () => {
    const root = resolve("agent");
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const [, path] of readFileSync(file, "utf8").matchAll(/^(?:import|export) .* from "(\.[^"]+)";$/gm)) visit(resolve(dirname(file), path));
    };
    visit(resolve(root, "fleet.mjs"));
    expect(seen.size).toBeGreaterThan(5);
    for (const file of seen) expect(relative(root, file).startsWith("..")).toBe(false);
  });
});
