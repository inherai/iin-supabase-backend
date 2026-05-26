-- Add role column to invites table to support recruiter invitations
ALTER TABLE invites ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'community';
