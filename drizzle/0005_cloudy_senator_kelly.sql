CREATE TABLE IF NOT EXISTS "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" integer NOT NULL,
	"title" text,
	"username" text,
	"first_name" text,
	"last_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chats_chat_id_unique" UNIQUE("chat_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claude_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "is_reply" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "chat_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "claude_thread_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claude_threads" ADD CONSTRAINT "claude_threads_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_claude_thread_id_claude_threads_id_fk" FOREIGN KEY ("claude_thread_id") REFERENCES "public"."claude_threads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
