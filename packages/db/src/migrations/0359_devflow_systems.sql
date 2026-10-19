CREATE TABLE "dr_request_systems" (
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"system_id" uuid NOT NULL,
	"assigned_by_user_id" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dr_request_systems_pk" PRIMARY KEY("case_id","system_id")
);
--> statement-breakpoint
CREATE TABLE "dr_systems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"repo_url" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"docs_path" text DEFAULT 'docs' NOT NULL,
	"token_secret_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dr_systems_key_check" CHECK ("dr_systems"."key" ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
	CONSTRAINT "dr_systems_repo_check" CHECK ("dr_systems"."repo_url" ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
	CONSTRAINT "dr_systems_docs_check" CHECK ("dr_systems"."docs_path" !~ '(^/|\.\.)'),
	CONSTRAINT "dr_systems_size_check" CHECK (char_length("dr_systems"."name") between 1 and 200 and char_length("dr_systems"."description") <= 2000 and char_length("dr_systems"."default_branch") between 1 and 200 and char_length("dr_systems"."docs_path") <= 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "dr_systems_id_company_uq" ON "dr_systems" USING btree ("id","company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "dr_systems_company_key_uq" ON "dr_systems" USING btree ("company_id","key");
--> statement-breakpoint
ALTER TABLE "dr_request_systems" ADD CONSTRAINT "dr_request_systems_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dr_request_systems" ADD CONSTRAINT "dr_request_systems_case_company_fk" FOREIGN KEY ("case_id","company_id") REFERENCES "public"."pipeline_cases"("id","company_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dr_request_systems" ADD CONSTRAINT "dr_request_systems_system_company_fk" FOREIGN KEY ("system_id","company_id") REFERENCES "public"."dr_systems"("id","company_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dr_systems" ADD CONSTRAINT "dr_systems_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "dr_request_systems_company_idx" ON "dr_request_systems" USING btree ("company_id","system_id");
