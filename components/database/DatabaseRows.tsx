import { lazy, Suspense } from "react";
const TableView = lazy(() => import("@/components/database/TableView"));
const BoardView = lazy(() => import("@/components/database/BoardView"));
const ListView = lazy(() => import("@/components/database/ListView"));
const GalleryView = lazy(() => import("@/components/database/GalleryView"));
const CalendarView = lazy(() => import("@/components/database/CalendarView"));
const TimelineView = lazy(() => import("@/components/database/TimelineView"));
import type { ViewProps } from "@/lib/dbView";
export default function DatabaseRows(props: ViewProps) {
  const View = { table: TableView, board: BoardView, list: ListView, gallery: GalleryView, calendar: CalendarView, timeline: TimelineView }[props.view.type];
  return <Suspense fallback={<div className="min-h-40" />}><View {...props} /></Suspense>;
}
