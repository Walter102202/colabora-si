"use client";
import { use } from "react";
import SharedPageView from "@/components/SharedPageView";
export default function SharedPage({ params }: { params: Promise<{ id: string }> }) { return <SharedPageView pageId={use(params).id} />; }
