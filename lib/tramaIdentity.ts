export const TRAMA = {
  name: "Trama",
  role: "Workspace agent",
  alt: "Trama, the agent of this workspace",
  src: "/brand/trama/v1/trama-256.png",
  srcSet: "/brand/trama/v1/trama-64.png 64w, /brand/trama/v1/trama-128.png 128w, /brand/trama/v1/trama-256.png 256w, /brand/trama/v1/trama-512.png 512w",
} as const;

export const isTrama = (agent: { is_platform?: boolean } | null | undefined) => agent?.is_platform === true;
