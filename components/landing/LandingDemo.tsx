import { useEffect, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { BookOpen, FileText, House, ListChecks } from "lucide-react";
import { DEMO_CALL, DEMO_END, DEMO_STEPS, demoBlocks, demoDelay, demoNote, demoOutcome, demoReducer, demoStart, demoStatus, demoStep, type DemoBlock, type DemoChoice, type DemoState } from "@/lib/landingDemo";
import { TramaImage } from "./TramaImage";
import { useReducedMotion } from "./useReducedMotion";

const HANDOVER = [
  { who: "Codex", role: "Worker", what: "Delivered the fix · v3" },
  { who: "Claude Code", role: "Lead", what: "Approved · deliverable v3 · brief v1" },
  { who: "CI", role: "", what: "CI passed" },
];

// The page at its longest. An invisible copy holds the window's height, so the page never jumps as the work appears.
const LONGEST: DemoState = { ...demoStart(true), choice: "approved" };

function Block({ block }: { block: DemoBlock }) {
  return (
    <div className="cs-authored">
      {block.by ? <span className="cs-dot" role="img" aria-label={`Edited by ${block.by}`} /> : <span />}
      <div className={block.by ? "cs-block cs-agent-block" : "cs-block"}>
        <strong>{block.title}{block.sign && <span className="cs-sign">{block.sign}</span>}</strong>
        {block.text}
        {block.ask && <div className="cs-ask">{block.ask}</div>}
        {block.checks && (
          <ul className="cs-check-list">
            {block.checks.map((check) => <li key={check.text}><span className="cs-check" aria-hidden="true">✓</span><span>{check.text}</span><span className="cs-tag">{check.tag}</span></li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

function TaskPage({ state }: { state: DemoState }) {
  return (
    <>
      <div className="cs-doc-eyebrow">ENGINEERING / BUGS</div>
      <h3>Fix the signup error</h3>
      <div className="cs-meta"><span className="cs-source">Lead: <b>Claude Code</b></span><span className="cs-source">Worker: <b>Codex</b></span></div>
      {demoBlocks(state).map((block) => <Block key={block.title} block={block} />)}
      <div className="cs-doc-note">{demoNote(state)}</div>
    </>
  );
}

export function LandingDemo() {
  const reducedMotion = useReducedMotion();
  const [state, dispatch] = useReducer(demoReducer, reducedMotion, demoStart);
  const [onScreen, setOnScreen] = useState(false);
  const section = useRef<HTMLElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const approve = useRef<HTMLButtonElement>(null);
  const decided = useRef<HTMLDivElement>(null);
  const { beat, choice } = state;
  const delay = demoDelay(state);
  const status = demoStatus(state);
  const current = demoStep(beat);
  const outcome = choice && demoOutcome(choice);

  useEffect(() => {
    if (reducedMotion || !onScreen || delay === null) return;
    const timer = setTimeout(() => dispatch({ type: "tick" }), delay);
    return () => clearTimeout(timer);
  }, [beat, choice, delay, onScreen, reducedMotion]);

  // The example plays for someone: it waits for the visitor to reach it and stops once they leave.
  useEffect(() => {
    if (!windowRef.current) return;
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => setOnScreen(entry.isIntersecting)), { threshold: 0.3 });
    observer.observe(windowRef.current);
    return () => observer.disconnect();
  }, []);

  // A finger leaves no hand behind, and a mouse click leaves focus on the button without meaning to stay.
  useEffect(() => {
    const demo = section.current;
    const shown = windowRef.current;
    if (!demo || !shown) return;
    const hover = (event: PointerEvent) => { if (event.pointerType === "mouse") dispatch({ type: "hand", pointer: event.type === "pointerenter" }); };
    const focusIn = (event: FocusEvent) => { if (event.target instanceof Element && event.target.matches(":focus-visible")) dispatch({ type: "hand", focused: true }); };
    const focusOut = (event: FocusEvent) => { if (!(event.relatedTarget instanceof Node && demo.contains(event.relatedTarget))) dispatch({ type: "hand", focused: false }); };
    shown.addEventListener("pointerenter", hover);
    shown.addEventListener("pointerleave", hover);
    demo.addEventListener("focusin", focusIn);
    demo.addEventListener("focusout", focusOut);
    return () => {
      shown.removeEventListener("pointerenter", hover);
      shown.removeEventListener("pointerleave", hover);
      demo.removeEventListener("focusin", focusIn);
      demo.removeEventListener("focusout", focusOut);
    };
  }, []);

  function openCard() {
    flushSync(() => dispatch({ type: "goto", beat: DEMO_END }));
    approve.current?.focus({ preventScroll: true });
  }
  function decide(next: DemoChoice) {
    flushSync(() => dispatch({ type: "choose", choice: next }));
    decided.current?.focus({ preventScroll: true });
  }

  return (
    <section className="cs-wrap" id="cs-product" ref={section} aria-label="Interactive workspace example">
      <div className="cs-demo-label">
        <span>ONE TASK, TWO AGENTS, YOUR DECISION</span>
        <div className="cs-stepper" role="group" aria-label="Explore the example">
          {DEMO_STEPS.map((step, index) => <button key={step.label} type="button" className="cs-step" aria-pressed={index === current} onClick={() => dispatch({ type: "goto", beat: reducedMotion ? step.still : step.beat })}>{step.label}</button>)}
        </div>
      </div>
      <div className="cs-window" id="cs-window" ref={windowRef}>
        <div className="cs-window-bar">
          <div className="cs-breadcrumb">Launch space <span aria-hidden="true">/</span><strong>Fix the signup error</strong></div>
          <span className="cs-state" data-tone={status.tone}>{status.text}</span>
        </div>
        <div className="cs-app">
          <aside className="cs-sidebar" aria-label="Workspace preview">
            <div className="cs-sidebar-title">Our workspace</div>
            <div className="cs-sidebar-item"><House aria-hidden="true" /> Home</div>
            <div className="cs-sidebar-item" data-current><FileText aria-hidden="true" /> Signup error</div>
            <div className="cs-sidebar-item"><ListChecks aria-hidden="true" /> Agent tasks</div>
            <div className="cs-sidebar-item"><BookOpen aria-hidden="true" /> Product notes</div>
          </aside>
          <div className="cs-document"><TaskPage state={state} /></div>
          <div className="cs-document cs-ghost" aria-hidden="true"><TaskPage state={LONGEST} /></div>
          {beat === DEMO_END && (
            <aside className="cs-assistant" aria-label="Trama example conversation">
              <div className="cs-assistant-head"><TramaImage px={38} /><div><strong>Trama</strong><span>Context: Fix the signup error</span></div></div>
              <div className="cs-chat-reply">Claude Code approved Codex’s fix and CI passed. Merging needs you.</div>
              <div className="cs-relay">
                <ol>
                  {HANDOVER.map((item) => <li key={item.who}><span className="cs-relay-mark" aria-hidden="true">✓</span><span className="cs-relay-who"><b>{item.who}</b>{item.role && <i>{item.role}</i>}</span><span className="cs-relay-what">{item.what}</span></li>)}
                </ol>
              </div>
              {outcome
                ? <div className="cs-accepted" ref={decided} tabIndex={-1} data-neutral={choice === "rejected" || undefined}><strong>{outcome.title}</strong>{outcome.text}</div>
                : (
                  <div className="cs-task-preview">
                    <strong>Needs your approval: Merge pull request #128?</strong>
                    <p className="cs-card-body">Runs exactly once outside the workspace and cannot be undone from here.</p>
                    <div className="cs-choice">
                      <button ref={approve} type="button" className="cs-primary is-cue" onClick={() => decide("approved")}>Approve</button>
                      <button type="button" className="cs-secondary" onClick={() => decide("rejected")}>Reject</button>
                    </div>
                  </div>
                )}
            </aside>
          )}
          <div className="cs-float" data-calling={beat === DEMO_CALL || undefined}>
            {beat === DEMO_CALL && <button type="button" className="cs-bubble" onClick={openCard}>1 decision waits for you<span>First: Fix the signup error</span></button>}
            <div className="cs-float-row">
              {beat < DEMO_CALL && <div className="cs-float-pill">What are you up to?</div>}
              <TramaImage px={56} alt="Trama" />
            </div>
          </div>
        </div>
      </div>
      <div className="cs-caption">
        <span>Illustrative demo · Sample content{!reducedMotion && <button type="button" className="cs-replay" onClick={() => dispatch({ type: "goto", beat: 0 })}>Replay</button>}</span>
        <span>Every step stays in the same workspace.</span>
      </div>
      <p className="cs-compat">Works with <b>Claude Code</b>, <b>Codex</b>, <b>Trama</b> and chat apps like <b>Claude</b> and <b>ChatGPT</b>. Other MCP clients connect through the bridge.</p>
    </section>
  );
}
