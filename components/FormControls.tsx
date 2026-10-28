import { useEffect, useId, useImperativeHandle, useRef, type ComponentProps, type Ref } from "react";

type LabelProps = { label: string; labelClassName?: string; focusOnMount?: boolean };
function useField<T extends HTMLElement>(id: string | undefined, focus: boolean | undefined, ref: Ref<T> | undefined) {
  const generatedId = useId(), element = useRef<T>(null);
  useImperativeHandle(ref, () => element.current!, []);
  useEffect(() => { if (focus) element.current?.focus(); }, [focus]);
  return { id: id ?? generatedId, ref: element };
}

export function Input({ label, labelClassName = "sr-only", focusOnMount, ref, id, ...props }: Omit<ComponentProps<"input">, "autoFocus"> & LabelProps) {
  const field = useField<HTMLInputElement>(id, focusOnMount, ref);
  return <><label htmlFor={field.id} className={labelClassName}>{label}</label><input {...props} {...field} /></>;
}
export function Select({ label, labelClassName = "sr-only", focusOnMount, ref, id, ...props }: Omit<ComponentProps<"select">, "autoFocus"> & LabelProps) {
  const field = useField<HTMLSelectElement>(id, focusOnMount, ref);
  return <><label htmlFor={field.id} className={labelClassName}>{label}</label><select {...props} {...field} /></>;
}
export function Textarea({ label, labelClassName = "sr-only", focusOnMount, ref, id, ...props }: Omit<ComponentProps<"textarea">, "autoFocus"> & LabelProps) {
  const field = useField<HTMLTextAreaElement>(id, focusOnMount, ref);
  return <><label htmlFor={field.id} className={labelClassName}>{label}</label><textarea {...props} {...field} /></>;
}
