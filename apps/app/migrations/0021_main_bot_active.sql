-- On/off switches for the reviewer panel: the main bot and the master switch for every bot.
-- Both default to on so existing workspaces keep their current behaviour.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS main_bot_active boolean NOT NULL DEFAULT true;

ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS bots_enabled boolean NOT NULL DEFAULT true;
