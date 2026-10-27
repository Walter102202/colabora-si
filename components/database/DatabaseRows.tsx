"use client";
import TableView from "@/components/database/TableView";
import BoardView from "@/components/database/BoardView";
import ListView from "@/components/database/ListView";
import GalleryView from "@/components/database/GalleryView";
import CalendarView from "@/components/database/CalendarView";
import TimelineView from "@/components/database/TimelineView";
import type { ViewProps } from "@/components/database/dbShared";
export default function DatabaseRows(props: ViewProps) {
  const View = { table: TableView, board: BoardView, list: ListView, gallery: GalleryView, calendar: CalendarView, timeline: TimelineView }[props.view.type];
  return <View {...props} />;
}
