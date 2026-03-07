-- Migration: Add messages table and bot_config table
-- Run against: postgresql://postgres:6e0c28919d0e71a5d464@jz9bd8.easypanel.host:5000/vivepipa

-- Messages table for conversation history
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- Bot configuration (single row, id=1)
CREATE TABLE IF NOT EXISTS bot_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    system_prompt TEXT,
    active BOOLEAN DEFAULT true,
    model VARCHAR(100) DEFAULT 'anthropic/claude-sonnet-4',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default config
INSERT INTO bot_config (id, active, model) VALUES (1, true, 'anthropic/claude-sonnet-4')
ON CONFLICT (id) DO NOTHING;
