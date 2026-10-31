import { useEffect, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

// A native modal dialog that also closes from its backdrop.
export function LandingDialog({ dialogRef, className, bodyClassName, labelledBy, children }: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  className: string;
  bodyClassName: string;
  labelledBy: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const dismiss = (event: MouseEvent) => { if (event.target === dialog) dialog.close(); };
    dialog.addEventListener("click", dismiss);
    return () => dialog.removeEventListener("click", dismiss);
  }, [dialogRef]);
  return (
    <dialog ref={dialogRef} className={className} aria-labelledby={labelledBy}>
      <div className={bodyClassName}>
        <button className="cs-x" type="button" aria-label="Close" onClick={() => dialogRef.current?.close()}><X aria-hidden="true" /></button>
        {children}
      </div>
    </dialog>
  );
}
