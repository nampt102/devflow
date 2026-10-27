ALTER TABLE "dr_requests" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dr_requests" ADD COLUMN "snoozed_by" text;--> statement-breakpoint
ALTER TABLE "dr_requests" ADD COLUMN "snooze_note" text;--> statement-breakpoint
CREATE INDEX "dr_requests_snoozed_idx" ON "dr_requests" USING btree ("company_id","snoozed_until") WHERE "dr_requests"."snoozed_until" is not null;