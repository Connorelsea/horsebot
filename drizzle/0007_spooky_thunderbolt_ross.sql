CREATE TABLE IF NOT EXISTS "claude_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"summary" text,
	"closed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "session_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claude_sessions" ADD CONSTRAINT "claude_sessions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_claude_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."claude_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
