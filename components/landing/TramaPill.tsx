import { useEffect, useRef, useState } from "react";
import { LandingDialog } from "./LandingDialog";
import { TramaImage } from "./TramaImage";

type Question = "what" | "can" | "in";

const QUESTIONS: { id: Question; label: string; reply: string }[] = [
  { id: "what", label: "What is colabora.si?", reply: "A shared workspace where your team and your AI agents work on the same pages. The context stays with the work, and you decide what happens next." },
  { id: "can", label: "What can you do?", reply: "I answer questions about the page you’re on and turn a proposal into work. I also save notes and take voice messages for you to check before sending." },
  { id: "in", label: "How do I get in?", reply: "The beta is by invitation. Join the waitlist and we’ll write to you when your invite is ready." },
];
// Trama stays out of the way while it is already on screen.
const ON_SCREEN = ["cs-hero", "cs-window", "cs-trama-img"];

export function TramaPill({ onWaitlist }: { onWaitlist: () => void }) {
  const panel = useRef<HTMLDialogElement>(null);
  const [away, setAway] = useState(true);
  const [question, setQuestion] = useState<Question | null>(null);

  useEffect(() => {
    const seen: Record<string, boolean> = {};
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => { seen[entry.target.id] = entry.isIntersecting; });
      setAway(ON_SCREEN.some((id) => seen[id]));
    }, { rootMargin: "-100px 0px -120px 0px" });
    ON_SCREEN.forEach((id) => { const target = document.getElementById(id); if (target) observer.observe(target); });
    return () => observer.disconnect();
  }, []);

  const answer = QUESTIONS.find((item) => item.id === question);
  return (
    <>
      <div className="cs-pill" data-away={away}>
        <button type="button" aria-haspopup="dialog" aria-label="Talk to Trama: What are you up to?" onClick={() => panel.current?.showModal()}>
          <span className="cs-pill__say" aria-hidden="true">What are you up to?</span><TramaImage px={48} />
        </button>
      </div>
      <LandingDialog dialogRef={panel} className="cs-tp" bodyClassName="cs-tp__in" labelledBy="cs-tp-t">
        <div className="cs-tp__head"><TramaImage px={42} /><div><b id="cs-tp-t">Trama</b><span>Sample answers</span></div></div>
        <div className="cs-tp__qs" role="group" aria-label="Questions for Trama">
          {QUESTIONS.map((item) => <button key={item.id} type="button" aria-pressed={item.id === question} onClick={() => setQuestion(item.id)}>{item.label}</button>)}
        </div>
        <div className="cs-tp__a" aria-live="polite">
          {answer?.reply}
          {answer?.id === "in" && <><br /><button className="cs-primary" type="button" onClick={() => { panel.current?.close(); onWaitlist(); }}>Join the waitlist</button></>}
        </div>
      </LandingDialog>
    </>
  );
}
