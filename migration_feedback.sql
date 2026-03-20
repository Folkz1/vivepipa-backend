-- Migration: Admin feedback system for bot improvement
-- Run against: postgresql://postgres:6e0c28919d0e71a5d464@jz9bd8.easypanel.host:5000/vivepipa

-- Feedback on individual bot messages (test mode)
CREATE TABLE IF NOT EXISTS message_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    phone VARCHAR(20) NOT NULL DEFAULT 'test_dashboard',
    rating VARCHAR(10) NOT NULL CHECK (rating IN ('good', 'bad')),
    category VARCHAR(50),
    expected_response TEXT,
    comment TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_message ON message_feedback(message_id);
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON message_feedback(rating);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON message_feedback(created_at DESC);

-- Improvement suggestions generated from feedback patterns
CREATE TABLE IF NOT EXISTS prompt_improvements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    current_prompt_hash VARCHAR(64),
    suggested_changes TEXT NOT NULL,
    based_on_count INTEGER DEFAULT 0,
    categories_addressed TEXT[],
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
