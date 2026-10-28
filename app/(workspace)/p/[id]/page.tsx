import { useParams } from "react-router";
import PageView from "@/components/PageView";
export default function PageRoute() {
  const { id } = useParams<{ id: string }>();
  return id ? <PageView key={id} pageId={id} /> : null;
}
