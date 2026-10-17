CREATE TABLE "dr_email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dr_email_outbox_status_check" CHECK ("dr_email_outbox"."status" in ('pending', 'sent', 'failed', 'skipped')),
	CONSTRAINT "dr_email_outbox_size_check" CHECK (char_length("dr_email_outbox"."subject") <= 300 and char_length("dr_email_outbox"."body") <= 5000 and char_length("dr_email_outbox"."to_email") <= 320 and ("dr_email_outbox"."last_error" is null or char_length("dr_email_outbox"."last_error") <= 200)),
	CONSTRAINT "dr_email_outbox_sent_check" CHECK (("dr_email_outbox"."status" = 'sent') = ("dr_email_outbox"."sent_at" is not null)),
	CONSTRAINT "dr_email_outbox_attempts_check" CHECK ("dr_email_outbox"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "dr_email_outbox" ADD CONSTRAINT "dr_email_outbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_email_outbox" ADD CONSTRAINT "dr_email_outbox_event_id_pipeline_case_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."pipeline_case_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_email_outbox" ADD CONSTRAINT "dr_email_outbox_case_company_fk" FOREIGN KEY ("case_id","company_id") REFERENCES "public"."pipeline_cases"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dr_email_outbox" ADD CONSTRAINT "dr_email_outbox_requester_company_fk" FOREIGN KEY ("requester_id","company_id") REFERENCES "public"."dr_requesters"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dr_email_outbox_event_uq" ON "dr_email_outbox" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "dr_email_outbox_pending_idx" ON "dr_email_outbox" USING btree ("next_attempt_at") WHERE "dr_email_outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "dr_email_outbox_company_case_idx" ON "dr_email_outbox" USING btree ("company_id","case_id","created_at");