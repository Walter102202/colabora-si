import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router";

export default function AppNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    const follow = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
      const url = new URL(anchor.href);
      if (url.origin !== location.origin || !/^\/(?:$|p\/|shared\/|pub\/|linked$|mcp-pat$)/.test(url.pathname)) return;
      event.preventDefault();
      void navigate(url.pathname + url.search + url.hash);
    };
    document.addEventListener("click", follow);
    return () => document.removeEventListener("click", follow);
  }, [navigate]);
  return <Outlet />;
}
