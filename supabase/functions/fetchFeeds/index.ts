/**
 * Edge Function: fetchFeeds
 *   – Lee la tabla `sources`
 *   – Descarga cada RSS y guarda artículos nuevos en `articles`
 *   – Calcula el embedding vía REST de OpenAI y lo guarda en `embeddings`
 *
 *  *Sin dependencias externas*: solo Supabase‐JS y rss-parser.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42";
import Parser from "https://esm.sh/rss-parser@3.13";

// ---------- helpers ---------- //
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const OPENAI_URL = "https://api.openai.com/v1/embeddings";

/** llama a la API REST y devuelve el vector (number[]) */
async function embed(text: string): Promise<number[]> {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-ada-002",
      input: text.slice(0, 4000), // máx ≈8 k tokens
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error: ${res.status} – ${err}`);
  }

  const json = await res.json();
  return json.data[0].embedding as number[];
}
// -------------------------------- //

Deno.serve(async () => {
  // 1. Supabase service-role
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 2. Fuentes
  const { data: sources, error: srcErr } = await supabase
    .from("sources")
    .select("id,name,url,bias_label");

  if (srcErr) return new Response(srcErr.message, { status: 500 });

  const parser  = new Parser();
  let inserted  = 0;

  // 3. Procesa cada RSS en serie (puedes cambiar a Promise.allSettled)
  for (const src of sources) {
    try {
      const feed = await parser.parseURL(src.url);

      for (const item of feed.items) {
        // 3.1 dedupe
        const { data: exists } = await supabase
          .from("articles")
          .select("id")
          .eq("url", item.link!)
          .maybeSingle();

        if (exists) continue;

        // 3.2 guarda artículo
        const { data: art } = await supabase
          .from("articles")
          .insert({
            title:        item.title,
            url:          item.link,
            published_at: item.pubDate ? new Date(item.pubDate) : new Date(),
            content:      item.contentSnippet ?? "",
            bias:         src.bias_label,
          })
          .select("id")
          .single();

        // 3.3 embedding
        const vector = await embed(item.contentSnippet ?? "");

        await supabase.from("embeddings").insert({
          article_id: art.id,
          embedding:  vector,
        });

        inserted++;
      }
    } catch (e) {
      console.error(`Feed ${src.name} error:`, e);
    }
  }

  return new Response(`Sync done. Articles inserted: ${inserted}`);
});