--
-- PostgreSQL database dump — schema only.
-- Taken with: pg_dump --schema-only "postgres://app:hunter2-fixture-secret@db.internal:5432/app"
--
-- pg_dump declares no key inline. Every primary key, unique constraint and
-- foreign key it writes is a trailing ALTER TABLE, in the block at the foot of
-- this file — so that is how this fixture writes them. `public.orders` keeps
-- the inline spellings a GUI export or a hand-written migration uses, so one
-- file holds both readings.
--

SET statement_timeout = 0;
SET search_path = public, pg_catalog;

CREATE SCHEMA audit;

CREATE TABLE public.customers (
    id bigint NOT NULL,
    email character varying(255) NOT NULL,
    "display name" text,
    api_token text DEFAULT 'sk-fixture-0123456789abcdef'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
    quantity integer DEFAULT 1 NOT NULL
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

-- No column list of its own: a drop reason, not a refusal of the file.
CREATE TABLE public.monthly_totals AS
    SELECT customer_id, sum(total) AS total FROM public.orders GROUP BY customer_id;

--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public
--
-- The shape pg_dump emits for a key of any kind, and the only place a dump
-- declares one: nothing above marks a column of these two tables.
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_email_key UNIQUE (email);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (order_id, sku);

CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);

-- This one names a table the dump does not declare, so it is dropped and said so.
ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_sku_fkey FOREIGN KEY (sku) REFERENCES public.skus(sku);
