CREATE TABLE "dr_agent_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"stage_key" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"prompt_role" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"comment_text" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" text,
	CONSTRAINT "dr_agent_outputs_status_check" CHECK ("dr_agent_outputs"."status" in ('proposed', 'accepted', 'overridden', 'superseded')),
	CONSTRAINT "dr_agent_outputs_data_check" CHECK (jsonb_typeof("dr_agent_outputs"."data") = 'object' and octet_length("dr_agent_outputs"."data"::text) <= 65536),
	CONSTRAINT "dr_agent_outputs_comment_check" CHECK (char_length("dr_agent_outputs"."comment_text") <= 20000),
	CONSTRAINT "dr_agent_outputs_names_check" CHECK ("dr_agent_outputs"."stage_key" <> '' and "dr_agent_outputs"."prompt_role" <> '' and "dr_agent_outputs"."prompt_version" <> '' and "dr_agent_outputs"."prompt_hash" <> ''),
	CONSTRAINT "dr_agent_outputs_decision_check" CHECK (("dr_agent_outputs"."status" <> 'proposed' or "dr_agent_outputs"."decided_at" is null)
        and ("dr_agent_outputs"."status" not in ('accepted', 'overridden') or ("dr_agent_outputs"."decided_at" is not null and "dr_agent_outputs"."decided_by_user_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "dr_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"output_id" uuid NOT NULL,
	"stage_key" text NOT NULL,
	"field" text NOT NULL,
	"agent_value" jsonb,
	"final_value" jsonb,
	"actor_user_id" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dr_overrides_field_check" CHECK (char_length("dr_overrides"."field") between 1 and 200),
	CONSTRAINT "dr_overrides_reason_check" CHECK ("dr_overrides"."reason" is null or char_length("dr_overrides"."reason") <= 4000),
	CONSTRAINT "dr_overrides_changed_check" CHECK ("dr_overrides"."agent_value" is distinct from "dr_overrides"."final_value")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "dr_agent_outputs_id_company_uq" ON "dr_agent_outputs" USING btree ("id","company_id");
--> statement-breakpoint
ALTER TABLE "dr_agent_outputs" ADD CONSTRAINT "dr_agent_outputs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dr_agent_outputs" ADD CONSTRAINT "dr_agent_outputs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dr_agent_outputs" ADD CONSTRAINT "dr_agent_outputs_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dr_agent_outputs" ADD CONSTRAINT "dr_agent_outputs_case_company_fk" FOREIGN KEY ("case_id","company_id") REFERENCES "public"."pipeline_cases"("id","company_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dr_overrides" ADD CONSTRAINT "dr_overrides_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dr_overrides" ADD CONSTRAINT "dr_overrides_case_company_fk" FOREIGN KEY ("case_id","company_id") REFERENCES "public"."pipeline_cases"("id","company_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dr_overrides" ADD CONSTRAINT "dr_overrides_output_company_fk" FOREIGN KEY ("output_id","company_id") REFERENCES "public"."dr_agent_outputs"("id","company_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "dr_agent_outputs_one_proposed_uq" ON "dr_agent_outputs" USING btree ("case_id","stage_key") WHERE "dr_agent_outputs"."status" = 'proposed';
--> statement-breakpoint
CREATE INDEX "dr_agent_outputs_case_stage_idx" ON "dr_agent_outputs" USING btree ("company_id","case_id","stage_key","created_at");
--> statement-breakpoint
CREATE INDEX "dr_agent_outputs_prompt_idx" ON "dr_agent_outputs" USING btree ("company_id","prompt_role","prompt_version");
--> statement-breakpoint
CREATE UNIQUE INDEX "dr_overrides_output_field_uq" ON "dr_overrides" USING btree ("output_id","field");
--> statement-breakpoint
CREATE INDEX "dr_overrides_company_created_idx" ON "dr_overrides" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "dr_overrides_company_stage_field_idx" ON "dr_overrides" USING btree ("company_id","stage_key","field");
--> statement-breakpoint
-- dr_embeddings needs pgvector. The embedded Postgres used by tests and by `pnpm dev` ships without it,
-- so the table is created only where the extension is available (see openspec/decisions/0013).
DO $devflow$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE "dr_embeddings" (
    	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    	"company_id" uuid NOT NULL,
    	"case_id" uuid NOT NULL,
    	"kind" text DEFAULT 'request' NOT NULL,
    	"model" text NOT NULL,
    	"dimensions" integer NOT NULL,
    	"embedding" vector NOT NULL,
    	"content_hash" text NOT NULL,
    	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
    	CONSTRAINT "dr_embeddings_kind_check" CHECK ("dr_embeddings"."kind" in ('request')),
    	CONSTRAINT "dr_embeddings_dimensions_check" CHECK ("dr_embeddings"."dimensions" between 1 and 16000 and vector_dims("dr_embeddings"."embedding") = "dr_embeddings"."dimensions"),
    	CONSTRAINT "dr_embeddings_names_check" CHECK ("dr_embeddings"."model" <> '' and "dr_embeddings"."content_hash" <> '')
    );

    ALTER TABLE "dr_embeddings" ADD CONSTRAINT "dr_embeddings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;

    ALTER TABLE "dr_embeddings" ADD CONSTRAINT "dr_embeddings_case_company_fk" FOREIGN KEY ("case_id","company_id") REFERENCES "public"."pipeline_cases"("id","company_id") ON DELETE cascade ON UPDATE no action;

    CREATE UNIQUE INDEX "dr_embeddings_case_kind_model_uq" ON "dr_embeddings" USING btree ("case_id","kind","model");

    CREATE INDEX "dr_embeddings_company_model_idx" ON "dr_embeddings" USING btree ("company_id","model");
  END IF;
END
$devflow$;
