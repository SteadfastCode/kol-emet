--
-- PostgreSQL database dump — schema only.
-- Taken with: pg_dump --schema-only "postgres://app:hunter2-fixture-secret@db.internal:5432/app"
--

SET statement_timeout = 0;
SET search_path = public, pg_catalog;

CREATE SCHEMA audit;

CREATE TABLE public.customers (
    id bigint NOT NULL,
    email character varying(255) NOT NULL,
    "display name" text,
    api_token text DEFAULT 'sk-fixture-0123456789abcdef'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customers_pkey PRIMARY KEY (id),
    CONSTRAINT customers_email_key UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS public.orders (
    id serial PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    total numeric(10,2) DEFAULT 0 NOT NULL,
    status text NOT NULL
);

CREATE TABLE public.order_items (
    order_id integer NOT NULL,
    sku text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    PRIMARY KEY (order_id, sku),
    FOREIGN KEY (order_id) REFERENCES public.orders (id)
);

-- The same table name in a second schema: both are proposed, each qualified.
CREATE TABLE audit.customers (
    id bigint PRIMARY KEY,
    changed_by text,
    changed_at timestamp with time zone DEFAULT now()
);

-- A function body is dollar-quoted and holds semicolons of its own; a split on
-- `;` would tear the rest of this file into nonsense.
CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id);

-- No column list of its own: a drop reason, not a refusal of the file.
CREATE TABLE public.monthly_totals AS
    SELECT customer_id, sum(total) AS total FROM public.orders GROUP BY customer_id;

-- The shape pg_dump actually emits for a foreign key. This one names a table
-- the dump does not declare, so it is dropped and said so.
ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_sku_fkey FOREIGN KEY (sku) REFERENCES public.skus(sku);
