import { useNavigate } from "react-router";
import { McpPatPage } from "@/components/agents/McpPatPage";
import { MCP_PAT_URL, settingsUrl } from "@/lib/routes";

export default function McpPatRoute() {
  const navigate = useNavigate();
  return <div className="h-full overflow-y-auto scrollbar-thin"><title>Connect an agent · colabora.si</title><McpPatPage onOpenSettings={() => { void navigate(settingsUrl("agents", MCP_PAT_URL)); }} /></div>;
}
