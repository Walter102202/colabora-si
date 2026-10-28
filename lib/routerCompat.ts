import { useMemo } from "react";
import { useNavigate } from "react-router";

// Compatibility boundary for agent components with the frozen navigation API.
export function useRouter() {
  const navigate = useNavigate();
  return useMemo(() => ({ push: (url: string) => { void navigate(url); } }), [navigate]);
}
