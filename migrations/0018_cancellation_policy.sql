-- A party's cancellation and refund policy (Phase 5, owner request). Additive only.
--
-- The organiser writes it (owner/admin, like the entry rules); guests see it on the
-- party page before paying and on their ticket page, and the request form's Terms
-- box covers it: "I agree to Sahra's Terms and this party's entry rules and
-- cancellation policy". The accepted version on the ticket (tickets.rules_version,
-- migration 0017) is a hash of both texts, so changing either one asks guests who
-- had the form open to review it again. NULL = the organiser has not written one.
ALTER TABLE parties ADD COLUMN cancellation_policy TEXT;
