# Change Log

## 2025-10-01

### Fixed: Unnecessary rescheduling of manual visits on every cron run

**Issue**: Manual visits were being cancelled and rescheduled every hour when the calendar check ran, even though nothing had changed.

**Changes**:
- Removed redundant `initializeScheduledVisits()` call from the hourly cron job (index.js:1348)
- Manual visits are now only initialized on server startup and when the scheduled_visits.json file changes via the file watcher
- This eliminates unnecessary job cancellation/recreation and reduces log noise

### Reduced log verbosity for calendar processing

**Issue**: Debug logs were showing "Processing arriving soon time" for every reservation on every hourly check, making logs noisy.

**Changes**:
- Removed debug log messages for arriving soon time processing (index.js:883-885, 903-905)
- Functionality remains the same, just quieter logs

### Fixed: Multiple duplicate notifications for manual visit mode changes

**Issue**: Manual visit mode changes were triggering multiple times, causing duplicate push notifications (9+ notifications for a single mode change event).

**Changes**:
- Removed `async` keyword from the map callback in `scheduleVisit()` function (index.js:615)
- The async keyword was causing the map to return Promises instead of scheduled job objects, leading to incorrect scheduling behavior

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
