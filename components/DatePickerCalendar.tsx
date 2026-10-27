"use client";
import { useState } from "react";
export const isoLocalDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export function formatIsoDate(iso: string): string { const date = new Date(iso + "T00:00:00"); return Number.isNaN(+date) ? iso : date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }); }
export default function DatePickerCalendar({ value, onSelect }: { value?: string | null; onSelect: (iso: string) => void }) {
  const [month, setMonth] = useState(() => { const date = value ? new Date(value + "T00:00:00") : new Date(); return Number.isNaN(+date) ? new Date() : date; });
  const year = month.getFullYear(), m = month.getMonth(), days = new Date(year, m + 1, 0).getDate(), start = new Date(year, m, 1).getDay();
  return <div className="date-calendar"><div className="flex items-center justify-between text-xs"><span>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span><button aria-label="Previous month" onClick={() => setMonth(new Date(year, m - 1, 1))}>‹</button><button onClick={() => setMonth(new Date())}>Today</button><button aria-label="Next month" onClick={() => setMonth(new Date(year, m + 1, 1))}>›</button></div><div className="calendar-grid">{["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => <span key={day} className="text-text-tertiary">{day}</span>)}{Array.from({ length: start }, (_, i) => <span key={`blank${i}`} />)}{Array.from({ length: days }, (_, i) => { const day = isoLocalDate(new Date(year, m, i + 1)); return <button key={day} aria-label={day} aria-pressed={day === value} className={day === isoLocalDate(new Date()) ? "text-accent" : ""} onClick={() => onSelect(day)}>{i + 1}</button>; })}</div></div>;
}
