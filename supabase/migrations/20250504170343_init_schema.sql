-- Fuentes de noticias
CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL,
  bias_label text,
  country text,
  created_at timestamptz DEFAULT now()
);

-- Artículos individuales
CREATE TABLE articles (
  id bigserial PRIMARY KEY,
  source_id uuid REFERENCES sources(id),
  title text,
  url text UNIQUE,
  published_at timestamptz,
  content text,
  bias text,
  created_at timestamptz DEFAULT now()
);

-- Embeddings OpenAI (1536 dimensiones)
CREATE TABLE embeddings (
  article_id bigint REFERENCES articles(id) ON DELETE CASCADE,
  embedding vector(1536)
);