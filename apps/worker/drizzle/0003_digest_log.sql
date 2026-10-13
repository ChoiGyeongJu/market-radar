CREATE TABLE "digest_log" (
	"source_id" text NOT NULL,
	"kst_date" date NOT NULL,
	"outcome" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_log_source_id_kst_date_pk" PRIMARY KEY("source_id","kst_date")
);
