CREATE TABLE IF NOT EXISTS "message_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"start_message_id" uuid NOT NULL,
	"end_message_id" uuid NOT NULL,
	"message_count" integer NOT NULL,
	"summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"summarized_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "claude_sessions" ADD COLUMN "trigger_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "chunk_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chunk_chat_index_idx" ON "message_chunks" USING btree ("chat_id","chunk_index");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_chunk_id_message_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."message_chunks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
