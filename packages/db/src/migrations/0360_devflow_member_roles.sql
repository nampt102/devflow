CREATE TABLE "dr_member_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dr_member_roles_role_check" CHECK ("dr_member_roles"."role" in ('ba', 'tech_lead'))
);
--> statement-breakpoint
ALTER TABLE "dr_member_roles" ADD CONSTRAINT "dr_member_roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dr_member_roles_company_user_role_uq" ON "dr_member_roles" USING btree ("company_id","user_id","role");--> statement-breakpoint
CREATE INDEX "dr_member_roles_company_user_idx" ON "dr_member_roles" USING btree ("company_id","user_id");