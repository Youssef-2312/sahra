-- Manual admits at the door (brainstorm idea 8): when a guest's QR will not scan,
-- door staff find them by name and admit them through the same single-use
-- redemption as a scan. Each one writes an audit row 'admitted_manually' with the
-- staff member, so the organiser can review them. This partial index serves that
-- review list without reading the whole audit table; only manual admits add to it.
CREATE INDEX audit_manual_admits ON audit(party_id, at) WHERE action = 'admitted_manually';
