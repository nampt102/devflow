ALTER TABLE "dr_systems" ADD COLUMN "dev_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dr_systems" ADD COLUMN "write_token_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "dr_systems" ADD COLUMN "test_command" text;--> statement-breakpoint
ALTER TABLE "dr_systems" ADD COLUMN "forbidden_paths" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "dr_systems" ADD COLUMN "allow_unprotected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dr_systems" ADD CONSTRAINT "dr_systems_test_command_check" CHECK ("dr_systems"."test_command" is null or char_length("dr_systems"."test_command") between 1 and 500);--> statement-breakpoint
ALTER TABLE "dr_systems" ADD CONSTRAINT "dr_systems_forbidden_paths_check" CHECK (cardinality("dr_systems"."forbidden_paths") <= 50);--> statement-breakpoint
ALTER TABLE "dr_systems" ADD CONSTRAINT "dr_systems_dev_token_check" CHECK (not "dr_systems"."dev_enabled" or "dr_systems"."write_token_secret_id" is not null);