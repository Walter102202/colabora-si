import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Singleton lazy en el navegador. La app es 100 % client-side; RLS es la
// frontera de seguridad. La sesión la persiste supabase-js en localStorage
// (por defecto). Sin variables de entorno la app sigue funcionando en local:
// getSupabase() devuelve null y todo llamador lo trata como "sin backend".

let client: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );
}

export function getSupabase(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (!url || !key) return null;
  client = createClient(url, key);
  return client;
}

