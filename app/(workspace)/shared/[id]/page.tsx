import { useParams } from "react-router";
import SharedPageView from "@/components/SharedPageView";
export default function SharedPage() {
  const { id } = useParams<{ id: string }>();
  return <><title>Shared page · colabora.si</title>{id && <SharedPageView key={id} pageId={id} />}</>;
}
