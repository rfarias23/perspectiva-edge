/**
 * Edge Function: fetchFeeds
 * Sincroniza los RSS listados en la tabla `sources`,
 * almacena artículos nuevos en `articles`
 * y guarda sus embeddings en `embeddings`.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42";
import OpenAI from "https://esm.sh/openai@4.14.1?target=deno";
import Parser from "https://esm.sh/rss-parser@3.13";

Deno.serve(async (req) => {
  // 1. Conexión Supabase (service role)
  const supabaseUrl  = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // 2. OpenAI embeddings
  const openai = new OpenAI({
    apiKey: Deno.env.get("OPENAI_API_KEY"),
  });

  // 3. Lee la lista de fuentes
  const { data: sources, error: srcErr } = await supabase
    .from("sources")
    .select("id,name,url,bias_label,country");

  if (srcErr) {
    console.error(srcErr);
    return new Response("Failed reading sources", { status: 500 });
  }

  const parser = new Parser();
  let inserted = 0;

  // 4. Recorre feeds en serie (o en paralelo con Promise.allSettled)
  for (const src of sources) {
    try {
      const feed = await parser.parseURL(src.url);

      for (const item of feed.items) {
        // Ignora si ya existe el artículo
        const { data: exists } = await supabase
          .from("articles")
          .select("id")
          .eq("url", item.link!)
          .maybeSingle();

        if (exists) continue;

        // 4.1 Inserta artículo
        const { data: art } = await supabase
          .from("articles")
          .insert({
            title: item.title,
            url: item.link,
            published_at: item.pubDate
              ? new Date(item.pubDate)
              : new Date(),
            content: item.contentSnippet ?? "",
            bias: src.bias_label,
          })
          .select("id")
          .single();

        // 4.2 Calcula embedding (recorta a 8k tokens aprox.)
        const text = (item.contentSnippet ?? "").slice(0, 4000);
        const emb = await openai.createEmbedding({
          model: "text-embedding-ada-002",
          input: text,
        });

        const vector = emb.data.data[0].embedding; // número[]

        // 4.3 Guarda embedding
        await supabase.from("embeddings").insert({
          article_id: art.id,
          embedding: vector,
        });

        inserted++;
      }
    } catch (e) {
      console.error(`Feed ${src.name} error:`, e);
    }
  }

  return new Response(`Sync done. Articles inserted: ${inserted}`);
});