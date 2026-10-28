export const isoLocalDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export function formatIsoDate(iso: string): string { const date = new Date(iso + "T00:00:00"); return Number.isNaN(+date) ? iso : date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); }
