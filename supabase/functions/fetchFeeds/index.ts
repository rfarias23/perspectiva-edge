/**
 * Edge Function: fetchFeeds
 *   – Lee `sources`
 *   – Descarga cada RSS (vía fetch) y extrae <item>
 *   – Inserta artículos nuevos y guarda sus embeddings
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42";
import { XMLParser }     from "https://esm.sh/fast-xml-parser@4.2.4?target=deno";

// ---------- configuración ----------
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const OPENAI_URL     = "https://api.openai.com/v1/embeddings";
// -----------------------------------

// ---------- utilidades -------------
async function embed(text: string): Promise<number[]> {
  const res = await fetch(OPENAI_URL, {
    method : "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type" : "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-ada-002",
      input: text.slice(0, 4_000),   // ~8 k tokens
    }),
  });

  if (!res.ok) throw new Error(await res.text());
  const json = await res.json();
  return json.data[0].embedding as number[];
}

const xml = new XMLParser({ ignoreAttributes: false });
// -----------------------------------

Deno.serve(async () => {
  // 1. Fuentes
  const { data: sources, error } = await supabase
    .from("sources")
    .select("id,name,url,bias_label");
  if (error) return new Response(error.message, { status: 500 });

  let inserted = 0;

  // 2. Recorre cada RSS
  for (const src of sources) {
    try {
      const rssRes = await fetch(src.url);
      if (!rssRes.ok) throw new Error(`HTTP ${rssRes.status}`);

      const feed = xml.parse(await rssRes.text());
      const items = feed.rss?.channel?.item ?? [];   // RSS 2.0

      for (const it of items) {
        const link  = it.link?.['#text'] ?? it.link;
        const title = it.title;
        if (!link || !title) continue;

        // 2.1 ¿Ya existe ese URL?
        const { data: exists } = await supabase
          .from("articles")
          .select("id")
          .eq("url", link)
          .maybeSingle();
        if (exists) continue;

        // 2.2 inserta artículo
        const { data: art } = await supabase
          .from("articles")
          .insert({
            title,
            url         : link,
            published_at: it.pubDate ? new Date(it.pubDate) : new Date(),
            content     : it.description ?? "",
            bias        : src.bias_label,
          })
          .select("id")
          .single();

        // 2.3 embedding
        const vector = await embed(it.description ?? "");
        await supabase.from("embeddings").insert({
          article_id: art.id,
          embedding : vector,
        });

        inserted++;
      }
    } catch (e) {
      console.error(`Feed ${src.name} – ${e}`);
    }
  }

  return new Response(`Sync done. Articles inserted: ${inserted}`);
});