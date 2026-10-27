"use client";

import type { BlockAttr } from "@/lib/types";

// Agent layer plug. Mounted by the block wrapper of the editor, to the left of
// the drag handle. Shows who made the last edit to the block. Stub for now.
export interface AttributionMarginProps {
  blockId: string;
  attr?: BlockAttr;
}

export function AttributionMargin(props: AttributionMarginProps) {
  void props;
  return null;
}
