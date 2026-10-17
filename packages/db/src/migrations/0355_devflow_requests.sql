CREATE TABLE "dr_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"uploaded_by_requester_id" uuid,
	"uploaded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dr_request_counters" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dr_requesters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dr_requests" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"request_number" integer NOT NULL,
	"requester_id" uuid NOT NULL,
	"description" text NOT NULL,
	"business_impact" text,
	"classification" text,
	"priority" text,
	"difficulty" text,
	"requires_human" boolean DEFAULT false NOT NULL,
	"requires_human_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"duplicate_of_case_id" uuid,
	"source" text DEFAULT 'portal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dr_requests_classification_check" CHECK ("dr_requests"."classification" is null or "dr_requests"."classification" in ('bug', 'feature', 'request')),
	CONSTRAINT "dr_requests_priority_check" CHECK ("dr_requests"."priority" is null or "dr_requests"."priority" in ('urgent', 'high', 'medium', 'low')),
	CONSTRAINT "dr_requests_difficulty_check" CHECK ("dr_requests"."difficulty" is null or "dr_requests"."difficulty" in ('easy', 'medium', 'hard')),
	CONSTRAINT "dr_requests_source_check" CHECK ("dr_requests"."source" in ('portal', 'email', 'manual')),
	CONSTRAINT "dr_requests_duplicate_not_self_check" CHECK ("dr_requests"."duplicate_of_case_id" is null or "dr_requests"."duplicate_of_case_id" <> "dr_requests"."case_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "dr_requesters_id_company_uq" ON "dr_requesters" USING btree ("id","company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_cases_id_company_uq" ON "pipeline_cases" USING btree ("id","company_id");
--> statement-breakpoint
ALTER TABLE "dr_attachments" ADD CONSTRAINT "dr_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_attachments" ADD CONSTRAINT "dr_attachments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_attachments" ADD CONSTRAINT "dr_attachments_case_company_fk" FOREIGN KEY ("case_id","company_id") REFERENCES "public"."pipeline_cases"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_attachments" ADD CONSTRAINT "dr_attachments_requester_company_fk" FOREIGN KEY ("uploaded_by_requester_id","company_id") REFERENCES "public"."dr_requesters"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_request_counters" ADD CONSTRAINT "dr_request_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_requesters" ADD CONSTRAINT "dr_requesters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_requesters" ADD CONSTRAINT "dr_requesters_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_requests" ADD CONSTRAINT "dr_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_requests" ADD CONSTRAINT "dr_requests_case_company_fk" FOREIGN KEY ("case_id","company_id") REFERENCES "public"."pipeline_cases"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_requests" ADD CONSTRAINT "dr_requests_requester_company_fk" FOREIGN KEY ("requester_id","company_id") REFERENCES "public"."dr_requesters"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_requests" ADD CONSTRAINT "dr_requests_duplicate_company_fk" FOREIGN KEY ("duplicate_of_case_id","company_id") REFERENCES "public"."pipeline_cases"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dr_attachments_asset_uq" ON "dr_attachments" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "dr_attachments_company_case_idx" ON "dr_attachments" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dr_requesters_company_user_uq" ON "dr_requesters" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "dr_requesters_user_idx" ON "dr_requesters" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dr_requests_company_number_uq" ON "dr_requests" USING btree ("company_id","request_number");--> statement-breakpoint
CREATE INDEX "dr_requests_company_requester_idx" ON "dr_requests" USING btree ("company_id","requester_id");--> statement-breakpoint
CREATE INDEX "dr_requests_company_created_idx" ON "dr_requests" USING btree ("company_id","created_at");
