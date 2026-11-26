-- Nullable, sem backfill: a origem dos snapshots antigos e desconhecida.
ALTER TABLE "InstagramProfileSnapshot" ADD COLUMN "source" TEXT;
