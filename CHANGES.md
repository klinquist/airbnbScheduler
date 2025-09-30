# Change Log

## 2025-09-30

### Fixed: Manual visits disappearing after page reload

**Issue**: Manual visits were being filtered out and deleted when the scheduled task ran because the `initializeScheduledVisits()` function was checking for a `visit.date` field that doesn't exist on manual visits.

**Changes**:
- Modified `initializeScheduledVisits()` filtering logic (index.js:692-723) to check the latest `modeChanges[].time` for manual visits instead of `visit.date`
- Manual visits now remain visible until after their last scheduled mode change has passed

### Fixed: Lock code management for manual visits

**Issue**: Lock codes were being set on the first mode change regardless of type, and were never removed.

**Changes**:
- Modified `scheduleVisit()` function (index.js:640-681) to handle lock codes based on mode type:
  - Lock code is now set only during "checkin" mode changes
  - Lock code is now removed during "checkout" mode changes
  - "arriving_soon" mode changes do not affect lock codes
