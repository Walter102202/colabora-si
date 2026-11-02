import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CONNECT_AGENT_NAMES } from "@/lib/agentConnectCatalog";
import { CONNECT_URL, connectUrl } from "@/lib/routes";
import { TramaImage } from "./TramaImage";

const UPCOMING = [
  { id: "gmail", name: "Gmail", file: "gmail.svg", x: 7, y: 48, tilt: -10, scale: 1.16 },
  { id: "linear", name: "Linear", file: "linear.svg", x: 10, y: 26, tilt: 8, scale: .92 },
  { id: "google-drive", name: "Google Drive", file: "google-drive.svg", x: 28, y: 13, tilt: 7, scale: .76 },
  { id: "google-meet", name: "Google Meet", file: "google-meet.svg", x: 50, y: 9, tilt: -6, scale: .72 },
  { id: "google-calendar", name: "Google Calendar", file: "google-calendar.svg", x: 72, y: 15, tilt: 8, scale: .74 },
  { id: "granola", name: "Granola", file: "granola.svg", x: 88, y: 30, tilt: -7, scale: 1, filled: true },
  { id: "slack", name: "Slack", file: "slack.png", x: 93, y: 52, tilt: 10, scale: 1.1, filled: true },
  { id: "figma", name: "Figma", file: "figma.svg", x: 86, y: 73, tilt: -8, scale: .92 },
  { id: "zoom", name: "Zoom", file: "zoom.png", x: 70, y: 88, tilt: 7, scale: .9 },
  { id: "hubspot", name: "HubSpot", file: "hubspot.svg", x: 48, y: 92, tilt: -5, scale: .96 },
  { id: "github", name: "GitHub", file: "github.svg", x: 25, y: 86, tilt: -9, scale: .98 },
  { id: "dropbox", name: "Dropbox", file: "dropbox.svg", x: 12, y: 70, tilt: 8, scale: .9, filled: true },
];

const AVAILABLE_AGENTS = ["claude-code", "codex", "chatgpt", "claude", "cursor", "muse-code", "gemini-cli", "antigravity", "hermes", "openclaw"];

export function LandingConnectors() {
  const [active, setActive] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const cloud = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!active) return;
    function dismiss(event: KeyboardEvent) {
      if (event.key === "Escape") setActive(null);
    }
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Element) || !cloud.current?.contains(event.target.closest(".cs-connector-item"))) setActive(null);
    }
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", outside);
    };
  }, [active]);

  return (
    <section className="cs-wrap cs-connectors" id="cs-connectors" aria-labelledby="cs-connectors-title">
      <div className="cs-connectors-upcoming">
        <div className="cs-connectors-copy">
          <div className="cs-connectors-kicker"><span className="cs-small-kicker">Connectors</span><span className="cs-connection-status" data-status="soon">Coming soon</span></div>
          <h2 id="cs-connectors-title">Your tools.<br /><em>Closer to the work.</em></h2>
          <p>We’re bringing email, files, meeting notes and conversations into colabora.si. Your favorite tools are on the way.</p>
          <span className="cs-connectors-hint">A little more connected. A lot more context.</span>
        </div>
        <div className="cs-connector-scene">
          <div className="cs-connector-orbit" aria-hidden="true" />
          <div className="cs-connector-hub">
            <TramaImage px={170} alt="Trama, at the heart of your workspace" lazy />
            <span>One shared workspace</span>
          </div>
          <ul className="cs-connector-cloud" aria-label="Coming soon connectors" ref={cloud}>
            {UPCOMING.map((connector) => (
              <li
                key={connector.id}
                className="cs-connector-item"
                data-active={active === connector.id || undefined}
                data-tooltip-align={connector.x <= 15 ? "start" : connector.x >= 85 ? "end" : undefined}
                data-tooltip-side={connector.y >= 80 ? "top" : undefined}
                style={{ "--connector-x": `${connector.x}%`, "--connector-y": `${connector.y}%`, "--connector-tilt": `${connector.tilt}deg`, "--connector-scale": connector.scale } as CSSProperties}
                onPointerEnter={(event) => {
                  if (event.pointerType !== "touch") { setHovered(connector.id); setActive(connector.id); }
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType !== "touch") {
                    setHovered(null);
                    setActive((current) => current === connector.id ? focused : current);
                  }
                }}
              >
                <button
                  className="cs-connector-tile"
                  data-filled={connector.filled || undefined}
                  type="button"
                  aria-label={connector.name}
                  aria-describedby={`cs-connector-tip-${connector.id}`}
                  onFocus={() => { setFocused(connector.id); setActive(connector.id); }}
                  onBlur={() => {
                    setFocused(null);
                    setActive((current) => current === connector.id ? hovered : current);
                  }}
                  onClick={() => setActive(connector.id)}
                >
                  <img src={`/brand/connectors/${connector.file}`} alt="" width={48} height={48} loading="lazy" draggable={false} />
                </button>
                <span className="cs-connector-tooltip" id={`cs-connector-tip-${connector.id}`} role="tooltip" hidden={active !== connector.id}>
                  {connector.name}<small>Coming soon</small>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="cs-available-connections" aria-labelledby="cs-available-title">
        <div className="cs-available-copy">
          <span className="cs-connection-status" data-status="available">Available now</span>
          <h3 id="cs-available-title">Your agents can <br />join today.</h3>
          <p>Connect the agents you already use to your shared pages. Choose an agent, review its access, and start working together.</p>
          <a className="cs-connect-agent" href={CONNECT_URL}>Connect an agent <span aria-hidden="true">↗</span></a>
          <span className="cs-connection-beta">Available to beta members.</span>
        </div>
        <div>
          <ul className="cs-available-grid" aria-label="Available agent connections">
            {AVAILABLE_AGENTS.map((id) => (
              <li key={id}>
                <a className="cs-available-agent" href={connectUrl(id)} aria-label={`Connect ${CONNECT_AGENT_NAMES[id]}`}>
                  <span className="cs-available-logo"><img src={`/brand/agents/${id}.svg`} alt="" width={32} height={32} loading="lazy" /></span>
                  <span>{CONNECT_AGENT_NAMES[id]}</span>
                  <span className="cs-agent-link-arrow" aria-hidden="true">↗</span>
                </a>
              </li>
            ))}
          </ul>
          <a className="cs-own-agent" href={connectUrl("your-agent")}><span aria-hidden="true">+</span> Or bring your own agent <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </section>
  );
}
