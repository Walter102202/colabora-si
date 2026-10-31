import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { BookOpen, FileText, House, Link as LinkIcon, ListChecks } from "lucide-react";
import { demoReducer, demoReview, demoSignature, demoStatus, demoTimers, demoWorkReply, initialDemo, type DemoStep } from "@/lib/landingDemo";
import { TramaImage } from "./TramaImage";
import { useReducedMotion } from "./useReducedMotion";

const STEPS: { step: DemoStep; label: string }[] = [{ step: 0, label: "1 · Brief" }, { step: 1, label: "2 · Work" }, { step: 2, label: "3 · Review" }];
const BRIEF = [
  { title: "Goal", text: "Turn our product notes into a clear plan for the private beta." },
  { title: "Done when", text: "The audience, core message and launch checklist are ready to review." },
  { title: "Constraints", text: "Use the linked notes. Flag open decisions. Keep the draft in this workspace." },
];
const DRAFT = [
  { title: "Who it’s for", text: "Small teams already working with AI agents who want a shared place for the work." },
  { title: "The core message", text: "People and agents work in the same pages, with context and decisions close at hand." },
  { title: "Launch checklist", text: "Prepare the demo. Review the invitation copy. Confirm the first beta group." },
];
const CHECKS = ["Audience defined from the notes", "Core message drafted", "Launch checklist included"];

const Dot = () => <span className="cs-dot" role="img" aria-label="Edited by Trama" />;
const Check = ({ text }: { text: string }) => <li><span className="cs-check" aria-hidden="true">✓</span> {text}</li>;

export function LandingDemo() {
  const reducedMotion = useReducedMotion();
  const [state, dispatch] = useReducer(demoReducer, initialDemo);
  const [note, setNote] = useState("");
  const [cue, setCue] = useState(false);
  const previous = useRef(state.activity);
  const app = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const toReview = useRef<HTMLButtonElement>(null);
  const accept = useRef<HTMLButtonElement>(null);
  const accepted = useRef<HTMLDivElement>(null);
  const { step, activity } = state;
  const status = demoStatus(state);
  const signature = demoSignature(state);
  const review = demoReview(state);
  const drafting = activity === "drafting";
  const revising = activity === "revising";

  useEffect(() => {
    const timers = demoTimers(activity, reducedMotion).map(({ after, event }) => setTimeout(() => dispatch(event), after));
    return () => timers.forEach(clearTimeout);
  }, [activity, reducedMotion]);

  useEffect(() => {
    if (reducedMotion) return;
    const timer = setTimeout(() => setCue(true), 900);
    return () => clearTimeout(timer);
  }, [reducedMotion]);

  // Keeps a keyboard or phone visitor at the next step, without pulling anyone back from elsewhere on the page.
  useEffect(() => {
    const was = previous.current;
    previous.current = activity;
    const focused = document.activeElement;
    if (focused && focused !== document.body && !focused.closest("#cs-product")) return;
    if (drafting && app.current && getComputedStyle(app.current).gridTemplateColumns.split(" ").length === 1) page.current?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
    if (was === "drafting" && activity === "idle") toReview.current?.focus({ preventScroll: true });
    if (was === "revising" && activity === "idle") accept.current?.focus({ preventScroll: true });
  }, [activity, drafting, reducedMotion]);

  function goTo(next: DemoStep) {
    if (next === 0) setNote("");
    dispatch({ type: "goto", step: next });
  }
  function openReview() {
    flushSync(() => dispatch({ type: "goto", step: 2 }));
    accept.current?.focus({ preventScroll: true });
  }
  function acceptDraft() {
    flushSync(() => dispatch({ type: "accept" }));
    accepted.current?.focus({ preventScroll: true });
  }
  function sendNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    dispatch({ type: "send", text: note });
    setNote("");
  }

  return (
    <section className="cs-wrap" id="cs-product" aria-label="Interactive workspace example">
      <div className="cs-demo-label">
        <span>ONE BRIEF, FROM REQUEST TO REVIEW</span>
        <div className="cs-stepper" role="group" aria-label="Explore the example">
          {STEPS.map((item) => <button key={item.step} type="button" className="cs-step" aria-pressed={item.step === step} onClick={() => goTo(item.step)}>{item.label}</button>)}
        </div>
      </div>
      <div className="cs-window" id="cs-window">
        <div className="cs-window-bar">
          <div className="cs-breadcrumb">Launch space <span aria-hidden="true">/</span><strong>Beta launch</strong></div>
          <span className="cs-state" data-tone={status.tone} role="status">{status.text}</span>
        </div>
        <div className="cs-app" ref={app}>
          <aside className="cs-sidebar" aria-label="Workspace preview">
            <div className="cs-sidebar-title">Our workspace</div>
            <div className="cs-sidebar-item"><House aria-hidden="true" /> Home</div>
            <div className="cs-sidebar-item" data-current><FileText aria-hidden="true" /> Beta launch</div>
            <div className="cs-sidebar-item"><ListChecks aria-hidden="true" /> Agent tasks</div>
            <div className="cs-sidebar-item"><BookOpen aria-hidden="true" /> Product notes</div>
          </aside>
          <div className="cs-document" ref={page} aria-live="polite">
            <div className="cs-doc-eyebrow">PRODUCT / LAUNCH</div>
            <h3>Beta launch brief</h3>
            <div className="cs-source"><LinkIcon aria-hidden="true" /> Source: Product notes</div>
            {step === 0 && <>
              {BRIEF.map((block) => <div className="cs-authored" key={block.title}><span /><div className="cs-block"><strong>{block.title}</strong>{block.text}</div></div>)}
              <div className="cs-doc-note">Written by you · Context stays with the page</div>
            </>}
            {step === 1 && <>
              {DRAFT.slice(0, state.draftBlocks).map((block) => (
                <div className={drafting ? "cs-authored is-new" : "cs-authored"} key={block.title}><Dot /><div className="cs-block cs-agent-block"><strong>{block.title} <span className="cs-sign">{signature}</span></strong>{block.text}</div></div>
              ))}
              <div className="cs-doc-note">Draft by Trama · 3 additions · Viewable with the original brief</div>
            </>}
            {step === 2 && <>
              <div className="cs-authored"><Dot /><div className="cs-block cs-agent-block">
                <strong>{review.title} <span className="cs-sign">{signature}</span></strong>
                <ul className="cs-check-list">
                  {CHECKS.map((check) => <Check key={check} text={check} />)}
                  {Array.from({ length: state.version - 1 }, (_, i) => <Check key={i} text="Updated from your note" />)}
                </ul>
              </div></div>
              <div className="cs-decision" data-done={state.accepted || undefined}>{review.note}</div>
              <div className="cs-authored"><span /><div className="cs-block"><strong>What stays with the work</strong>The brief, source page, draft and your decision.</div></div>
              <div className="cs-doc-note">{review.caption}</div>
            </>}
          </div>
          <aside className="cs-assistant" aria-label="Trama example conversation">
            <div className="cs-assistant-head"><TramaImage px={38} /><div><strong>Trama</strong><span>Context: Beta launch brief</span></div></div>
            <div className="cs-chat-human">Turn these notes into a launch brief and a checklist.</div>
            {step === 0 && <>
              <div className="cs-chat-reply">I can draft both using this page and its linked notes. You’ll review the result.</div>
              <div className="cs-task-preview">
                <div className="cs-task-label">PROPOSED WORK</div>
                <strong>Draft the beta launch brief</strong>
                <button type="button" className={cue ? "cs-primary is-cue" : "cs-primary"} disabled={activity === "starting"} onClick={() => { setCue(false); dispatch({ type: "start" }); }}>
                  {activity === "starting" ? "Starting…" : <>Do it <span aria-hidden="true">→</span></>}
                </button>
              </div>
              <div className="cs-assistant-note">A proposal becomes a task when you choose to start it.</div>
            </>}
            {step === 1 && <>
              <div className="cs-chat-reply">{demoWorkReply(state)}</div>
              {!drafting && <>
                <div className="cs-task-preview">
                  <div className="cs-task-label">WORK SUBMITTED</div>
                  <strong>v1 · page Beta launch brief</strong>
                  <button ref={toReview} type="button" className="cs-primary" onClick={openReview}>Review the result <span aria-hidden="true">→</span></button>
                </div>
                <div className="cs-assistant-note">You can see which blocks I added before accepting the result.</div>
              </>}
            </>}
            {step === 2 && <>
              <div className="cs-chat-reply">{review.reply}</div>
              {!state.accepted && !revising && (
                <div className="cs-task-preview">
                  <div className="cs-task-label">YOUR DECISION</div>
                  <strong>Keep this version of the launch brief?</strong>
                  <button ref={accept} type="button" className="cs-primary" onClick={acceptDraft}>Accept and close <span aria-hidden="true">✓</span></button>
                  <form className="cs-composer" onSubmit={sendNote}>
                    <label className="sr" htmlFor="cs-fb-text">Feedback for the agent</label>
                    <textarea id="cs-fb-text" rows={2} placeholder="Tell the agent what to change or what you decided…" value={note} onChange={(event) => setNote(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
                    <div className="cs-composer__row"><span>Ctrl+Enter to send</span><button className="cs-send" type="submit" disabled={!note.trim()}>Send</button></div>
                  </form>
                </div>
              )}
              {state.accepted && <div className="cs-accepted" ref={accepted} tabIndex={-1}><strong>Accepted by you.</strong>The result and your decision stay with the task.</div>}
              <div className="cs-assistant-note" aria-live="polite">{state.note && `Sent to Trama: “${state.note}”`}</div>
            </>}
          </aside>
        </div>
      </div>
      <div className="cs-caption"><span>Illustrative demo · Sample content</span><span>Every step stays in the same workspace.</span></div>
      <p className="cs-compat">Works with <b>Claude Code</b>, <b>Codex</b>, <b>Trama</b> and chat apps like <b>Claude</b> and <b>ChatGPT</b>. Other MCP clients connect through the bridge.</p>
    </section>
  );
}
