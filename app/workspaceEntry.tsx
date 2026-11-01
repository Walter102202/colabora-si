import { createRoot } from "react-dom/client";
import { createBrowserRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import AppNavigation from "@/components/AppNavigation";
import Shell from "@/components/Shell";
import HydrationGate from "@/components/HydrationGate";
import "./globals.css";

const router = createBrowserRouter([{ element: <AppNavigation />, HydrateFallback: () => null, children: [
  { element: <HydrationGate><Shell><Outlet /></Shell></HydrationGate>, children: [
    { index: true, lazy: async () => ({ Component: (await import("./(workspace)/page")).default }) },
    { path: "p/:id", lazy: async () => ({ Component: (await import("./(workspace)/p/[id]/page")).default }) },
    { path: "shared/:id", lazy: async () => ({ Component: (await import("./(workspace)/shared/[id]/page")).default }) },
    { path: "linked", lazy: async () => ({ Component: (await import("./linked/page")).default }) },
    { path: "agents", lazy: async () => ({ Component: (await import("./agents/page")).default }) },
    { path: "mcp-pat", lazy: async () => ({ Component: (await import("./mcp-pat/page")).default }) },
    { path: "connect", lazy: async () => ({ Component: (await import("./connect/page")).default }) },
    { path: "connect/:agent", lazy: async () => ({ Component: (await import("./connect/page")).default }) },
    { path: "*", element: <div className="empty-state"><title>Page not found · colabora.si</title>Page not found.</div> },
  ] },
  { path: "pub/:id", lazy: async () => ({ Component: (await import("./(public)/pub/[id]/page")).default }) },
  { path: "oauth/consent", lazy: async () => ({ Component: (await import("./oauth/consent/page")).default }) },
] }]);

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
