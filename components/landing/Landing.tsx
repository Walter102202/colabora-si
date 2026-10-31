import { useRef, useState, type MouseEvent } from "react";
import { LandingDemo } from "./LandingDemo";
import { LoginDialog } from "./LoginDialog";
import { TramaImage } from "./TramaImage";
import { TramaPill } from "./TramaPill";
import { WaitlistForm } from "./WaitlistForm";
import "./landing.css";

const FAQ = [
  { question: "Can I bring an agent I already use?", answer: "Yes. Works with Claude Code, Codex and chat apps like Claude and ChatGPT. Other MCP clients connect through the bridge. Create the agent in Settings → Agents, then paste the setup it gives you. Chat apps connect by signing in." },
  { question: "Where do I stay in control?", answer: "Choose how much agents may do alone, for the whole workspace or for one task: Ask first, Balanced or Autonomous. Review what a run changed, then revert the items you choose. Accepting a delivery always takes a person." },
  { question: "What carries into the next task?", answer: "The brief and the history. Lessons from corrections can also be proposed for your approval and used in later work, each with the reason it applies." },
  { question: "What does Trama do?", answer: "Trama is the workspace’s own agent. It answers about the open page, takes voice, saves notes when you ask, and proposes work that becomes a task with Do it. Audio is sent to Meta to transcribe and is not kept." },
  { question: "How do I get into the beta?", answer: "Access is by invitation. Join the waitlist and we’ll write to you when your invite is ready." },
];

const Wordmark = () => <>colabora<span>.si</span></>;

export default function Landing() {
  const login = useRef<HTMLDialogElement>(null);
  const loginEmail = useRef<HTMLInputElement>(null);
  const waitlistEmail = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");

  function goToWaitlist(prefill = "") {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("cs-join")?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    if (prefill) setEmail(prefill);
    waitlistEmail.current?.focus({ preventScroll: true });
  }
  function followToWaitlist(event: MouseEvent) {
    event.preventDefault();
    goToWaitlist();
  }
  function openLogin() {
    login.current?.showModal();
    loginEmail.current?.focus();
  }

  return (
    <div className="landing">
      <header className="cs-navbar">
        <div className="cs-wrap cs-nav">
          <a href="#cs-top" className="cs-wordmark"><Wordmark /></a>
          <nav className="cs-links" aria-label="Main navigation"><a href="#cs-product">The workspace</a><a href="#cs-trama">Meet Trama</a><a href="#cs-faq">FAQ</a></nav>
          <button className="cs-login" type="button" onClick={openLogin}>Log in</button>
          <a className="cs-nav-cta" href="#cs-join" onClick={followToWaitlist}>Join the beta →</a>
        </div>
      </header>
      <main id="cs-top">
        <section className="cs-wrap cs-hero" id="cs-hero" aria-labelledby="cs-title">
          <div><div className="cs-eyebrow">A shared workspace</div><h1 id="cs-title">Your team.<br />Your agents.<br /><em>On the same page.</em></h1></div>
          <div className="cs-hero-copy">
            <p className="cs-lede">Work with AI agents in shared pages. Keep the context, review changes, and decide what happens next.</p>
            <div className="cs-actions"><a href="#cs-join" className="cs-primary" onClick={followToWaitlist}>Join the beta waitlist <span aria-hidden="true">↗</span></a><a href="#cs-product" className="cs-text-link">Explore the workspace</a></div>
            <span className="cs-beta">Private beta · Access by invitation</span>
            <a href="#cs-trama" className="cs-trama-intro"><TramaImage px={70} /><div><strong>Start with Trama.</strong><span>Your workspace’s own collaborator ↗</span></div></a>
          </div>
        </section>

        <LandingDemo />

        <section className="cs-wrap">
          <div className="cs-feature">
            <div><div className="cs-small-kicker">Continuity, built into the work</div><h2>Switch agents.<br />Keep the work.</h2><p>Pass a task on with its brief, history and next step. The shared workspace gives the next agent a place to continue.</p></div>
            <div className="cs-handoff">
              <div className="cs-handoff-title">Beta launch · the same task</div>
              <div className="cs-shared-context"><span>✓ Brief</span><span>✓ History</span><span>✓ Next step</span></div>
              <div className="cs-agent-pair"><div><strong>Claude Code</strong><span>Checkpoint saved</span></div><div className="cs-arrow" aria-hidden="true">→</div><div><strong>Codex</strong><span>Continues the task</span></div></div>
              <p className="cs-handoff-line">Can continue from checkpoint #12 (claude_code, 5m ago)</p>
            </div>
          </div>
        </section>

        <section className="cs-wrap">
          <div className="cs-context">
            <h2>Keep the context useful.</h2>
            <div className="cs-context-examples">
              <div className="cs-context-example"><span className="cs-context-tag">✓ Lesson accepted by you</span><strong>Keep corrections worth remembering.</strong><p>Accept a lesson from a correction so future tasks can use it, with its scope and source attached.</p><p className="cs-example">Lesson: Keep launch messages under 12 words. Applies to: This project.</p></div>
              <div className="cs-context-example"><span className="cs-context-tag" data-changed>◷ Internal source page changed</span><strong>See what needs another look.</strong><p>When a linked source page changes, review the differences and decide whether the dependent page should change too.</p><p className="cs-example">The source says “Start with 20 teams”. The page says “Start with 10 teams”.</p></div>
            </div>
          </div>
        </section>

        <section className="cs-wrap" id="cs-trama">
          <div className="cs-trama-section">
            <TramaImage id="cs-trama-img" px={211} alt="Trama" lazy />
            <div><div className="cs-small-kicker">A familiar face in your workspace</div><h2>Meet Trama.</h2><p>Ask about the page you’re on, turn a proposal into a task, or save a note. Trama keeps the conversation close to the work.</p><p className="cs-muse">Trama runs on Muse Spark. Voice is transcribed with Muse.</p><div className="cs-trama-capabilities"><span>Page context</span><span>Voice notes</span><span>Work proposals</span></div></div>
          </div>
        </section>

        <section className="cs-wrap">
          <div className="cs-bottom">
            <div className="cs-faq" id="cs-faq">
              <h3>A few things you might be wondering.</h3>
              {FAQ.map((item) => <details key={item.question}><summary>{item.question}</summary><p>{item.answer}</p></details>)}
            </div>
            <div className="cs-join" id="cs-join">
              <h2>Bring your agents<br />onto the same page.</h2>
              <p className="cs-join-sub">Join the beta waitlist. We’ll write to you when your invite is ready.</p>
              <WaitlistForm emailRef={waitlistEmail} email={email} onEmail={setEmail} />
            </div>
          </div>
        </section>
      </main>
      <footer className="cs-wrap cs-footer">
        <div className="cs-wordmark"><Wordmark /></div>
        <span>Built for the Meta Global AI Developer Hackathon · Trama runs on Muse Spark</span>
        <span><a href="https://github.com/Walter102202/colabora-si">GitHub</a> · © 2026 colabora.si</span>
        <span>People and AI agents.<br />One shared place to work.</span>
      </footer>
      <LoginDialog dialogRef={login} emailRef={loginEmail} onWaitlist={goToWaitlist} />
      <TramaPill onWaitlist={goToWaitlist} />
    </div>
  );
}
