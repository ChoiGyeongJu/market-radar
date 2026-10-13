CREATE TABLE "macro_fire" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"event_id" bigint NOT NULL,
	"presses" integer NOT NULL,
	"trigger" text NOT NULL,
	"outcome" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "macro_fire_fired_at_idx" ON "macro_fire" USING btree ("fired_at");