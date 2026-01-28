const axios = require("axios");
const ical = require("ical");
const moment = require("moment-timezone");
const config = require("config");
const schedule = require("node-schedule");
const retry = require("async-retry");
const fs = require("fs");
const express = require("express");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const chokidar = require("chokidar");
const bodyParser = require("body-parser");
const Pushover = require("pushover-notifications");

// Promisify fs functions
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

// Initialize Pushover
let pushover = null;
if (config.has("pushover")) {
  try {
    const pushoverConfig = {
      user: config.get("pushover.user"),
      token: config.get("pushover.token"),
      debug: false, // Disable debug messages
      onerror: (error) => {
        console.error(`Pushover error: ${error}`);
      },
    };

    // Only add device if it's configured
    if (config.has("pushover.device")) {
      pushoverConfig.device = config.get("pushover.device");
    }

    pushover = new Pushover(pushoverConfig);
    console.log("Pushover initialized successfully");
  } catch (error) {
    console.error(`Failed to initialize Pushover: ${error}`);
  }
} else {
  console.log(
    "No Pushover configuration found, notifications will be disabled"
  );
}

// Function to send Pushover notification
const sendPush = (msg) => {
  if (!pushover) {
    console.log("Pushover not configured, skipping notification");
    return;
  }
  pushover.send(
    {
      message: msg,
      title: "Airbnb Lock Code",
      sound: "magic",
      priority: 1,
    },
    (err) => {
      if (err) {
        console.error(err);
      }
    }
  );
};

// Define logging functions
const log = {
  debug: (msg) => {
    const now = moment().format("Y-MM-DD h:mm A");
    console.log(`${now} - DEBUG: ${msg}`);
  },
  info: (msg) => {
    const now = moment().format("Y-MM-DD h:mm A");
    console.log(`${now} - INFO: ${msg}`);
    if (pushover) {
      sendPush(msg);
    }
  },
  error: (msg) => {
    const now = moment().format("Y-MM-DD h:mm A");
    console.log(`${now} - ERROR: ${msg}`);
    if (pushover) {
      sendPush(msg);
    }
  },
};

const getLockCodeSlot = () => {
  let slot = config.get("lock_code_slot");
  if (typeof slot === "number") {
    slot = slot.toString();
  }
  return slot;
};

const getHubitatUrl = (path) => {
  const hubitatIp = config.get("hubitat_ip");
  const hubitatAccessToken = config.get("hubitat_maker_api_access_token");
  return `http://${hubitatIp}/apps/api/9/${path}?access_token=${hubitatAccessToken}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const formatDate = (date) => {
  const now = moment();
  const targetDate = moment(date).tz(config.get("timezone"));
  const diffDays = targetDate.diff(now, "days");

  // If it's today
  if (targetDate.isSame(now, "day")) {
    return `today at ${targetDate.format("h:mm A")}`;
  }

  // If it's tomorrow
  if (diffDays === 1) {
    return `tomorrow at ${targetDate.format("h:mm A")}`;
  }

  // If it's within the next week
  if (diffDays > 0 && diffDays <= 7) {
    return `this ${targetDate.format("dddd")} at ${targetDate.format(
      "h:mm A"
    )}`;
  }

  // For dates further in the future, show the full date
  return targetDate.format("MMM D, YYYY h:mm A z");
};

// Keep track of recent mode changes to prevent duplicates
const recentModeChanges = new Map();
const MODE_CHANGE_COOLDOWN = 60000; // 1 minute cooldown between identical mode changes

// Consolidated function for mode changes
const handleModeChange = async (modeName, reason = "") => {
  const now = Date.now();
  const key = `${modeName}-${reason}`;

  // Check if this exact mode change was made recently
  const lastChange = recentModeChanges.get(key);
  if (lastChange && now - lastChange < MODE_CHANGE_COOLDOWN) {
    log.debug(
      `Skipping duplicate mode change to ${modeName} (${reason}) - too soon after last change`
    );
    return;
  }

  try {
    const modes = await axios.get(getHubitatUrl("modes"));
    const mode = modes.data.find(
      (n) => n.name.toUpperCase() == modeName.toUpperCase()
    );

    if (!mode) {
      log.error(`Could not find mode ${modeName}`);
      return;
    }

    if (mode.active) {
      log.debug(`Mode ${modeName} is already active.`);
      return;
    }

    await axios.get(getHubitatUrl(`modes/${mode.id}`));
    log.info(
      `Successfully set mode to ${modeName} ${reason ? `(${reason})` : ""}`
    );

    // Record this mode change
    recentModeChanges.set(key, now);

    // Clean up old entries from recentModeChanges
    for (const [changeKey, timestamp] of recentModeChanges.entries()) {
      if (now - timestamp > MODE_CHANGE_COOLDOWN) {
        recentModeChanges.delete(changeKey);
      }
    }
  } catch (error) {
    log.error(`Error setting mode to ${modeName}: ${error}`);
    throw error;
  }
};

const setLockCode = async (phoneNumber, reservationNumber) => {
  let locks;
  try {
    locks = await axios.get(getHubitatUrl("devices"));
  } catch (e) {
    throw new Error(`Error getting list of devices: ${e.message}`);
  }

  const locksToCode = config.get("locks_to_code");
  locks = locks.data.filter((n) => locksToCode.includes(n.label));

  let lockCodeBody = [
    getLockCodeSlot(),
    phoneNumber,
    reservationNumber,
  ].join(",");

  const serialLoopFlow = async (locks) => {
    for (const lock in locks) {
      try {
        await setLockWithRetry(locks[lock], lockCodeBody, phoneNumber);
      } catch (e) {
        log.error(`Error setting code on lock ${locks[lock].name}: ${e}`);
      }
    }
  };
  await serialLoopFlow(locks);
};

const setLockWithRetry = async (lock, lockCodeBody, phoneNumber) => {
  await retry(
    async (bail) => {
      // if anything throws, we retry
      await axios
        .get(getHubitatUrl(`devices/${lock.id}/setCode/${lockCodeBody}`))
        .then(() => {
          log.debug(`Programmed code ${phoneNumber} on lock ${lock.name}`);
        })
        .catch((err) => {
          log.debug(`Error setting code on lock ${lock.name}: ${err}`);
        });
      log.debug("Waiting 10 seconds and asking the lock to refresh");
      await sleep(10000);
      await getHubitatUrl(`devices/${lock.id}/refresh`);
      await sleep(10000);
      log.debug("Getting lock codes");
      let lockData = await axios
        .get(getHubitatUrl(`devices/${lock.id}/getCodes`))
        .catch((err) => {
          log.error(err);
        });
      let attrib;
      try {
        attrib = JSON.parse(
          lockData.data.attributes.find((n) => n.name == "lockCodes")
            .currentValue
        );
      } catch (e) {
        log.error(`Error parsing lock codes: ${e}`);
        return bail();
      }
      const slot = getLockCodeSlot();
      attrib = attrib[slot] && attrib[slot].code;
      if (attrib !== phoneNumber) {
        log.error(
          `Lock code not set correctly on lock ${lock.name}, retrying a total of 3x`
        );
        throw new Error();
      }
      log.info(`Successfully set code ${phoneNumber} on lock ${lock.label}`);
    },
    {
      retries: 3,
      minTimeout: 30000,
    }
  );
};

const removeLockCode = async (phoneNumber) => {
  let locks;
  try {
    locks = await axios.get(getHubitatUrl("devices"));
  } catch (e) {
    throw new Error(`Error getting list of devices ${e}`);
  }

  const locksToCode = config.get("locks_to_code");
  locks = locks.data.filter((n) => {
    return locksToCode.includes(n.label);
  });

  const serialLoopFlow = async (locks) => {
    for (const lock in locks) {
      await axios
        .get(
          getHubitatUrl(
            `devices/${locks[lock].id}/deleteCode/${getLockCodeSlot()}`
          )
        )
        .then(() => {
          log.info(
            `Successfully removed code ${phoneNumber} from lock ${locks[lock].label}`
          );
        })
        .catch((err) => {
          log.error(`Error setting code on lock ${locks[lock].name}: ${err}`);
        });
    }
  };

  await serialLoopFlow(locks);
};

const schedules = {};
let currentCode = [];

const convertStrToDate = (str) => {
  str = str.replace(/\s/g, "").toUpperCase();
  const match = str.match(/(\d+):(\d+)(A|P)?/);
  if (!match || !match[1] || !match[2])
    throw new Error(`Could not convert time to cron format: ${str}`);
  let hr;
  if (match[3] == "A" && Number(match[1]) == 12) {
    hr = 0;
  } else if (match[3] == "P" && Number(match[1]) < 12) {
    hr = Number(match[1]) + 12;
  } else {
    hr = Number(match[1]);
  }
  return {
    hr,
    min: Number(match[2]),
    sec: "0",
  };
};

const getNonEmptyConfigString = (key) => {
  if (!config.has(key)) return null;
  const value = config.get(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const normalizeIcalDescription = (description) => {
  if (typeof description !== "string") return "";
  // Some feeds encode newlines as the two characters "\n"
  return description.replace(/\\n/g, "\n");
};

const extractPhoneLast4FromDescription = (description) => {
  const normalized = normalizeIcalDescription(description);
  const labeled = normalized.match(
    /Phone Number\s*\(Last 4 Digits\)\s*:\s*([0-9]{4})/i
  );
  if (labeled && labeled[1]) return labeled[1];

  const looseLabeled = normalized.match(/Last 4 Digits[^0-9]*([0-9]{4})/i);
  if (looseLabeled && looseLabeled[1]) return looseLabeled[1];

  return null;
};

const extractHoufyReservationNumber = (event) => {
  const description = normalizeIcalDescription(event?.description);
  const urlMatch = description.match(/houfy\.com\/reservation\/([A-Za-z0-9]+)/i);
  if (urlMatch && urlMatch[1]) return urlMatch[1];

  // Some feeds also embed the reservation id in the UID (e.g. "1-ABC123...")
  const uid = typeof event?.uid === "string" ? event.uid : "";
  const uidMatch = uid.match(/-([A-Za-z0-9]+)$/);
  if (uidMatch && uidMatch[1]) return uidMatch[1];

  return null;
};

const extractAirbnbReservationNumber = (event) => {
  const description = normalizeIcalDescription(event?.description);
  const match = description.match(/([A-Z0-9]{9,})/g);
  if (match && match[0]) return match[0];
  return null;
};

const extractReservationNumberFromEvent = (event) => {
  if (event?.platform === "houfy") return extractHoufyReservationNumber(event);
  return extractAirbnbReservationNumber(event);
};

const parseIcalUrl = async (url, platform) => {
  const resp = await axios.get(url);
  if (!resp || typeof resp.data === "undefined") {
    throw new Error("No iCal data found");
  }

  const data = ical.parseICS(resp.data);
  if (!data || Object.keys(data).length === 0) return [];

  const events = [];
  for (const k in data) {
    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
    const ev = data[k];
    if (!ev || !ev.start || !ev.end || !ev.summary) continue;

    if (platform === "airbnb" && ev.summary === "Airbnb (Not available)") {
      continue;
    }

    if (platform === "houfy" && !/^Booked\b/i.test(String(ev.summary))) {
      continue;
    }

    events.push({ ...ev, platform });
  }

  return events;
};

const getiCalEvents = async () => {
  const events = [];

  const sources = [];
  const airbnbUrl =
    getNonEmptyConfigString("airbnb_ical_url") ||
    getNonEmptyConfigString("ical_url");
  const houfyUrl = getNonEmptyConfigString("houfy_ical_url");

  if (airbnbUrl) sources.push({ platform: "airbnb", url: airbnbUrl });
  if (houfyUrl) sources.push({ platform: "houfy", url: houfyUrl });

  if (sources.length === 0) {
    log.error(
      "No iCal URLs configured. Set ical_url (Airbnb) and/or houfy_ical_url."
    );
    return events;
  }

  for (const source of sources) {
    try {
      const sourceEvents = await parseIcalUrl(source.url, source.platform);
      log.debug(
        `Found ${sourceEvents.length} upcoming reservations in ${source.platform} calendar.`
      );
      events.push(...sourceEvents);
    } catch (err) {
      log.error(`Error getting ${source.platform} iCal: ${err.message || err}`);
    }
  }

  if (events.length === 0) {
    log.debug("No reservations found");
  }

  return events;
};

// Update the runCheckInActions function
const runCheckInActions = async (ph, reservationNumber) => {
  log.info("Running check in actions");
  try {
    await setLockCode(ph, reservationNumber);
  } catch (err) {
    log.error(`Error setting lock code: ${err}`);
  }

  let mode = config.get("checkin_mode");
  if (mode) {
    try {
      await handleModeChange(
        mode,
        `Check-in for reservation ${reservationNumber}`
      );
    } catch (err) {
      log.error(`Error setting mode: ${err}`);
    }
  }
};

// Update the runCheckOutActions function
const runCheckOutActions = async (ph, reservationNumber) => {
  log.info("Running check out actions");
  try {
    await removeLockCode(ph);
  } catch (err) {
    log.error(`Error removing lock code: ${err}`);
  }
  let mode = config.get("checkout_mode");
  if (mode) {
    try {
      await handleModeChange(
        mode,
        `Check-out for reservation ${reservationNumber}`
      );
    } catch (err) {
      log.error(`Error setting mode: ${err}`);
    }
  }
};

// Update the runArrivingSoonActions function
const runArrivingSoonActions = async (ph, reservationNumber) => {
  let mode = config.get("arriving_soon_mode");
  if (mode) {
    try {
      await handleModeChange(
        mode,
        `Arriving soon for reservation ${reservationNumber}`
      );
    } catch (err) {
      log.error(`Error setting mode: ${err}`);
    }
  } else {
    log.error(`No arriving_soon_mode set in config`);
  }
};

const dateInPast = function (firstDate) {
  return firstDate.getTime() < new Date().getTime();
};

const startSchedule = (sched) => {
  if (!dateInPast(new Date(sched.start))) {
    log.debug(
      `Scheduling check-in actions for reservation ${
        sched.reservationNumber
      } at ${formatDate(sched.start)}`
    );
    sched.startSchedule = schedule.scheduleJob(
      new Date(sched.start),
      ((context) => {
        runCheckInActions(context.phoneNumber, context.reservationNumber);
      }).bind(null, {
        phoneNumber: sched.phoneNumber,
        reservationNumber: sched.reservationNumber,
      })
    );
  } else {
    log.debug(`Skipping scheduling start date - it's in the past`);
  }

  if (!dateInPast(new Date(sched.end))) {
    log.debug(
      `Scheduling check-out actions for reservation ${
        sched.reservationNumber
      } at ${formatDate(sched.end)}`
    );
    sched.endSchedule = schedule.scheduleJob(
      new Date(sched.end),
      ((context) => {
        runCheckOutActions(context.phoneNumber, context.reservationNumber);
      }).bind(null, {
        phoneNumber: sched.phoneNumber,
        reservationNumber: sched.reservationNumber,
      })
    );
  } else {
    log.debug(`Skipping scheduling end date - it's in the past`);
  }

  if (sched.arriving) {
    if (!dateInPast(new Date(sched.arriving))) {
      log.debug(
        `Scheduling arriving soon actions for reservation ${
          sched.reservationNumber
        } at ${formatDate(sched.arriving)}`
      );
      sched.arrivingSoonSchedule = schedule.scheduleJob(
        new Date(sched.arriving),
        ((context) => {
          log.debug(
            `Executing arriving soon actions for reservation ${context.reservationNumber}`
          );
          runArrivingSoonActions(
            context.phoneNumber,
            context.reservationNumber
          );
        }).bind(null, {
          phoneNumber: sched.phoneNumber,
          reservationNumber: sched.reservationNumber,
        })
      );
    } else {
      log.debug(`Skipping scheduling arrivingSoon date - it's in the past`);
    }
  } else {
    log.debug(
      `No arriving soon date set for reservation ${sched.reservationNumber}`
    );
  }
};

const SCHEDULED_VISITS_FILE = "scheduled_visits.json";
const scheduledVisitJobs = new Map(); // Store cron jobs for scheduled visits

// Add file watcher for scheduled visits file
let scheduledVisitsWatcher = null;
let scheduledVisitsCache = null;
let lastWriteTime = 0;
const WRITE_COOLDOWN = 1000; // 1 second cooldown between writes
let isWatcherDisabled = false; // Add flag to control file watcher

// Initialize file watcher
const initFileWatcher = () => {
  try {
    const filePath = path.join(__dirname, "data", "scheduled_visits.json");
    scheduledVisitsWatcher = chokidar.watch(filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    scheduledVisitsWatcher.on("change", (path) => {
      if (!isWatcherDisabled) {
        log.debug("Scheduled visits file modified externally");
        scheduledVisitsCache = null; // Invalidate cache
      } else {
        log.debug("File watcher temporarily disabled, ignoring change");
      }
    });

    scheduledVisitsWatcher.on("error", (error) => {
      log.error(`File watcher error: ${error}`);
    });
  } catch (error) {
    log.error(`Failed to initialize file watcher: ${error}`);
  }
};

// Add function to control file watcher
const setWatcherEnabled = (enabled) => {
  isWatcherDisabled = !enabled;
  log.debug(`File watcher ${enabled ? "enabled" : "disabled"}`);
};

// Modified readScheduledVisits function with caching
const readScheduledVisits = async () => {
  try {
    // Return cached data if available
    if (scheduledVisitsCache !== null) {
      return scheduledVisitsCache;
    }

    const filePath = path.join(__dirname, "data", "scheduled_visits.json");
    const data = await readFileAsync(filePath, "utf8");
    const visits = JSON.parse(data);

    // Update cache
    scheduledVisitsCache = visits;
    return visits;
  } catch (error) {
    log.error(`Error reading scheduled visits: ${error}`);
    return [];
  }
};

// Modified writeScheduledVisits function with change detection and watcher control
const writeScheduledVisits = async (visits) => {
  try {
    const filePath = path.join(__dirname, "data", "scheduled_visits.json");

    // Read current file content
    const currentData = await readFileAsync(filePath, "utf8");
    const currentVisits = JSON.parse(currentData);

    // Compare current and new visits
    const hasChanges = JSON.stringify(currentVisits) !== JSON.stringify(visits);

    if (!hasChanges) {
      log.debug("No changes detected in scheduled visits, skipping write");
      return;
    }

    // Check if we're within the cooldown period
    const now = Date.now();
    if (now - lastWriteTime < WRITE_COOLDOWN) {
      log.debug("Within write cooldown period, skipping write");
      return;
    }

    // Disable file watcher before writing to prevent infinite loop
    setWatcherEnabled(false);
    
    try {
      // Write new data
      await writeFileAsync(filePath, JSON.stringify(visits, null, 2));
      lastWriteTime = now;

      // Update cache
      scheduledVisitsCache = visits;

      log.debug("Successfully wrote scheduled visits to file");
    } finally {
      // Always re-enable file watcher, even if write fails
      setWatcherEnabled(true);
    }
  } catch (error) {
    log.error(`Error writing scheduled visits: ${error}`);
    throw error;
  }
};

// Update the scheduleVisit function to use the watcher control
const scheduleVisit = (visit) => {
  log.debug(
    `Scheduling visit ${visit.id} with ${visit.modeChanges.length} mode changes`
  );

  // Cancel existing jobs if they exist
  if (scheduledVisitJobs.has(visit.id)) {
    log.debug(`Cancelling existing jobs for visit ${visit.id}`);
    scheduledVisitJobs.get(visit.id).forEach((job) => {
      if (job && typeof job.cancel === "function") {
        job.cancel();
      }
    });
    scheduledVisitJobs.delete(visit.id);
  }

  // Create jobs for each mode change
  const jobs = visit.modeChanges.map((change, changeIndex) => {
    const changeDate = moment(change.time).tz(config.get("timezone")).toDate();

    // Get the appropriate mode from config based on the selected mode
    let mode;
    switch (change.mode) {
      case "checkin":
        mode = config.get("checkin_mode");
        break;
      case "checkout":
        mode = config.get("checkout_mode");
        break;
      case "arriving_soon":
        mode = config.get("arriving_soon_mode");
        break;
      default:
        log.error(`Invalid mode selected: ${change.mode}`);
        return null;
    }

    if (!mode) {
      log.error(`No mode configured for ${change.mode}`);
      return null;
    }

    return schedule.scheduleJob(changeDate, async () => {
      try {
        await handleModeChange(mode, `Scheduled visit ${visit.id}`);

        // Set lock code on check-in
        if (visit.phone && change.mode === "checkin") {
          try {
            await setLockCode(visit.phone, `${visit.name}`);
          } catch (err) {
            log.error(`Error setting lock code: ${err}`);
          }
        }

        // Remove lock code on check-out
        if (visit.phone && change.mode === "checkout") {
          try {
            await removeLockCode(visit.phone);
          } catch (err) {
            log.error(`Error removing lock code: ${err}`);
          }
        }

        // If this is the last mode change, clean up
        if (changeIndex === visit.modeChanges.length - 1) {
          try {
            // Remove the visit from the file
            const visits = await readScheduledVisits();
            const updatedVisits = visits.filter((v) => v.id !== visit.id);
            await writeScheduledVisits(updatedVisits);
            log.debug(`Removed completed visit ${visit.id} from storage`);

            // Remove the jobs from our map
            scheduledVisitJobs.delete(visit.id);
            log.debug(`Cleaned up jobs for visit ${visit.id}`);
          } catch (cleanupError) {
            log.error(`Error during cleanup of visit ${visit.id}: ${cleanupError}`);
          }
        }
      } catch (err) {
        log.error(`Error executing mode change for visit ${visit.id}: ${err}`);
      }
    });
  });

  // Filter out null jobs and store the rest
  const validJobs = jobs.filter((job) => job !== null);
  scheduledVisitJobs.set(visit.id, validJobs);
  log.debug(
    `Successfully scheduled ${validJobs.length} jobs for visit ${visit.id}`
  );
};

// Function to initialize scheduled visits
const initializeScheduledVisits = async () => {
  try {
    log.debug("Initializing scheduled visits...");
    const visits = await readScheduledVisits();
    const now = moment().tz(config.get("timezone"));
    log.debug(`Current time: ${now.format("MMM D, YYYY h:mm A z")}`);

    // Filter out past visits and schedule future ones
    const futureVisits = visits.filter((visit) => {
      // For manual visits, check the latest mode change time
      if (visit.modeChanges && visit.modeChanges.length > 0) {
        // Find the latest mode change time
        const latestModeChange = visit.modeChanges.reduce((latest, change) => {
          const changeTime = moment(change.time).tz(config.get("timezone"));
          return changeTime.isAfter(latest) ? changeTime : latest;
        }, moment(0));

        const isFuture = latestModeChange.isAfter(now);
        if (!isFuture) {
          log.debug(
            `Filtering out past visit ${
              visit.id
            } (latest mode change was ${latestModeChange.format("MMM D, YYYY h:mm A z")})`
          );
        }
        return isFuture;
      }

      // Fallback for visits with a date field (legacy support)
      const visitDate = moment(visit.date).tz(config.get("timezone"));
      const isFuture = visitDate.isAfter(now);
      if (!isFuture) {
        log.debug(
          `Filtering out past visit ${
            visit.id
          } scheduled for ${visitDate.format("MMM D, YYYY h:mm A z")}`
        );
      }
      return isFuture;
    });

    log.debug(`Found ${futureVisits.length} future visits to schedule`);

    // Schedule all future visits
    futureVisits.forEach((visit) => {
      scheduleVisit(visit);
    });

    // Update the file to only contain future visits
    await writeScheduledVisits(futureVisits);
    log.debug("Successfully initialized scheduled visits");
  } catch (error) {
    log.error(`Error initializing scheduled visits: ${error}`);
  }
};

// Function to add a new scheduled visit
const addScheduledVisit = async (visit) => {
  try {
    log.debug(
      `Adding new scheduled visit for ${moment(visit.date)
        .tz(config.get("timezone"))
        .format("MMM D, YYYY h:mm A z")}`
    );
    const visits = await readScheduledVisits();
    visit.id = Date.now().toString(); // Ensure visit has an ID
    visits.push(visit);
    await writeScheduledVisits(visits);
    scheduleVisit(visit);
    log.debug(`Successfully added and scheduled visit ${visit.id}`);
    return visit;
  } catch (error) {
    log.error(`Error adding scheduled visit: ${error}`);
    throw error;
  }
};

// Function to delete a scheduled visit
const deleteScheduledVisit = async (id) => {
  try {
    log.debug(`Deleting scheduled visit ${id}`);
    const visits = await readScheduledVisits();
    const updatedVisits = visits.filter((visit) => visit.id !== id);
    await writeScheduledVisits(updatedVisits);

    // Cancel the scheduled jobs if they exist
    if (scheduledVisitJobs.has(id)) {
      log.debug(`Cancelling jobs for visit ${id}`);
      scheduledVisitJobs.get(id).forEach((job) => {
        if (job && typeof job.cancel === "function") {
          job.cancel();
        }
      });
      scheduledVisitJobs.delete(id);
    }
    log.debug(`Successfully deleted visit ${id}`);
  } catch (error) {
    log.error(`Error deleting scheduled visit: ${error}`);
    throw error;
  }
};

// Add after the SCHEDULED_VISITS_FILE constant
const LATE_CHECKOUTS_FILE = path.join(__dirname, "data", "late_checkouts.json");

// Add after the readScheduledVisits function
const readLateCheckouts = async () => {
  try {
    const filePath = path.join(__dirname, "data", "late_checkouts.json");
    const data = await readFileAsync(filePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    // If file doesn't exist or is invalid, return empty object
    if (error.code === "ENOENT") {
      return {};
    }
    log.error(`Error reading late checkouts: ${error}`);
    return {};
  }
};

const writeLateCheckouts = async (checkouts) => {
  try {
    const filePath = path.join(__dirname, "data", "late_checkouts.json");
    await writeFileAsync(filePath, JSON.stringify(checkouts, null, 2));
    log.debug("Successfully wrote late checkouts to file");
  } catch (error) {
    log.error(`Error writing late checkouts: ${error}`);
    throw error;
  }
};

// Modify the getSchedules function to apply late checkouts
const getSchedules = async (firstRun) => {
  log.debug("Refreshing schedules");

  const events = await getiCalEvents().catch((err) => {
    throw new Error(err);
  });

  if (!events) {
    return log.error("No events found");
  }

  // Load late checkouts
  const lateCheckouts = await readLateCheckouts();

  const currentSchedules = [];
  for (let i = 0; i < events.length; i++) {
    const timeStart = convertStrToDate(config.get("arrivalScheduleTime"));
    const timeEnd = convertStrToDate(config.get("departureScheduleTime"));
    const dateStart = new Date(
      events[i].start.getUTCFullYear(),
      events[i].start.getMonth(),
      events[i].start.getDate(),
      timeStart.hr,
      timeStart.min,
      timeStart.sec
    );
    let dateEnd = new Date(
      events[i].end.getUTCFullYear(),
      events[i].end.getMonth(),
      events[i].end.getDate(),
      timeEnd.hr,
      timeEnd.min,
      timeEnd.sec
    );
    const reservationNumber = extractReservationNumberFromEvent(events[i]);
    if (!reservationNumber) {
      log.error(
        `Could not extract reservation number from ${
          events[i].platform || "unknown"
        } event: ${events[i].summary || "(no summary)"}`
      );
      continue;
    }

    // Apply late checkout if it exists
    if (lateCheckouts[reservationNumber]) {
      const lateCheckoutTime = new Date(lateCheckouts[reservationNumber]);
      if (lateCheckoutTime > dateEnd) {
        log.debug(
          `Applying late checkout for reservation ${reservationNumber}: ${formatDate(
            lateCheckoutTime
          )}`
        );
        dateEnd = lateCheckoutTime;
      } else {
        // If the late checkout time is in the past or before original checkout, remove it
        delete lateCheckouts[reservationNumber];
        await writeLateCheckouts(lateCheckouts);
      }
    }

    const phoneNumber = extractPhoneLast4FromDescription(events[i].description);
    if (!phoneNumber) {
      log.error(
        `Could not extract phone number last 4 digits for reservation ${reservationNumber} (${
          events[i].platform || "unknown"
        })`
      );
      continue;
    }

    let arrivingSoonStart, arrivingSoonDate;
    if (config.get("arrivingSoonTime")) {
      arrivingSoonStart = convertStrToDate(config.get("arrivingSoonTime"));

      // Create the base date from the check-in date
      arrivingSoonDate = new Date(
        events[i].start.getUTCFullYear(),
        events[i].start.getMonth(),
        events[i].start.getDate(),
        arrivingSoonStart.hr,
        arrivingSoonStart.min,
        arrivingSoonStart.sec
      );

      // Apply the day offset (default to 0 if not set)
      const dayOffset = config.has("arrivingSoonDayOffset")
        ? config.get("arrivingSoonDayOffset")
        : 0;
      arrivingSoonDate.setDate(arrivingSoonDate.getDate() + dayOffset);
    }

    // Skip if the reservation is in the past
    if (dateInPast(dateEnd)) {
      log.debug(
        `Skipping past reservation ${reservationNumber} (ended ${formatDate(
          dateEnd
        )})`
      );
      continue;
    }

    if (!schedules[reservationNumber]) {
      let logMessage = `New reservation ${reservationNumber} scheduled for ${formatDate(
        dateStart
      )} to ${formatDate(dateEnd)}`;

      log.debug(logMessage);
      let sched = {
        start: dateStart.toISOString(),
        end: dateEnd.toISOString(),
        phoneNumber,
        reservationNumber: reservationNumber,
        platform: events[i].platform || "airbnb",
      };
      if (arrivingSoonDate) {
        sched.arriving = arrivingSoonDate.toISOString();
      }
      schedules[reservationNumber] = sched;
      startSchedule(schedules[reservationNumber]);
    }

    if (
      schedules[reservationNumber].start !== dateStart.toISOString() ||
      schedules[reservationNumber].end !== dateEnd.toISOString() ||
      schedules[reservationNumber].platform !== (events[i].platform || "airbnb")
    ) {
      log.info(`Reservation ${reservationNumber} schedule changed!`);
      log.debug(
        `Previous schedule: ${formatDate(
          schedules[reservationNumber].start
        )} to ${formatDate(schedules[reservationNumber].end)}`
      );
      log.debug(
        `New schedule: ${formatDate(dateStart)} to ${formatDate(dateEnd)}`
      );

      if (schedules[reservationNumber].arrivingSoonSchedule)
        schedules[reservationNumber].arrivingSoonSchedule.cancel();
      if (schedules[reservationNumber].startSchedule)
        schedules[reservationNumber].startSchedule.cancel();
      if (schedules[reservationNumber].endSchedule)
        schedules[reservationNumber].endSchedule.cancel();
      schedules[reservationNumber] = {
        start: dateStart.toISOString(),
        end: dateEnd.toISOString(),
        phoneNumber,
        reservationNumber: reservationNumber,
        platform: events[i].platform || "airbnb",
      };
      if (arrivingSoonDate) {
        schedules[reservationNumber].arriving = arrivingSoonDate.toISOString();
      }
      startSchedule(schedules[reservationNumber]);
    }

    if (moment().isBetween(dateStart, dateEnd)) {
      currentCode = [phoneNumber, reservationNumber];
    }

    currentSchedules.push(reservationNumber);
  }

  // Check for schedules that need to be removed!
  for (const k in schedules) {
    if (currentSchedules.indexOf(k) == -1) {
      log.info(`Reservation ${k} has been deleted, removing the schedule!`);
      // Cancel all scheduled jobs
      if (schedules[k].arrivingSoonSchedule)
        schedules[k].arrivingSoonSchedule.cancel();
      if (schedules[k].startSchedule) schedules[k].startSchedule.cancel();
      if (schedules[k].endSchedule) schedules[k].endSchedule.cancel();

      // If the reservation is currently active (guest is staying)
      if (
        moment().isBetween(
          new Date(schedules[k].start),
          new Date(schedules[k].end)
        )
      ) {
        if (
          config.get(
            "run_checkout_immediately_if_reservation_is_cancelled_mid_stay"
          )
        ) {
          log.info(
            `Reservation ${k} is currently active but has been canceled, removing lock code and running checkout actions`
          );
          runCheckOutActions(
            schedules[k].phoneNumber,
            schedules[k].reservationNumber
          );
          delete schedules[k];
        } else {
          log.info(
            `Reservation ${k} is currently active but has been canceled, check out actions will run at normally scheduled time (${formatDate(
              schedules[k].end
            )})`
          );
        }
      } else {
        // If the reservation hasn't started yet, just delete it without running any actions
        log.info(
          `Reservation ${k} was cancelled before it started (was scheduled for ${formatDate(
            schedules[k].start
          )}), removing schedule without running any actions`
        );
        delete schedules[k];
      }
    }
  }

  if (currentCode.length == 0) {
    log.debug("No active codes at this time");
  } else {
    log.debug(
      `Active code ${currentCode[0]} is programmed for current guest (reservation ${currentCode[1]})`
    );
  }
};

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  log.debug(`${req.method} ${req.url}`);
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  log.error(`Unhandled error: ${err.message}`);
  res.status(500).json({
    error: "Internal Server Error",
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Get the configured timezone
app.get("/api/timezone", (req, res) => {
  res.json({ timezone: config.get("timezone") });
});

// Get current schedules
app.get("/api/schedules", (req, res) => {
  // Create a clean version of schedules without Job objects
  const cleanSchedules = {};
  for (const key in schedules) {
    cleanSchedules[key] = {
      start: schedules[key].start,
      end: schedules[key].end,
      phoneNumber: schedules[key].phoneNumber,
      reservationNumber: schedules[key].reservationNumber,
      arriving: schedules[key].arriving,
      platform: schedules[key].platform,
    };
  }
  res.json(cleanSchedules);
});

// Force a schedule refresh (fetch iCal feeds now)
app.post("/api/schedules/refresh", async (req, res) => {
  try {
    await getSchedules();
    res.json({ success: true });
  } catch (error) {
    log.error(`Error refreshing schedules: ${error.message}`);
    res.status(500).json({
      error: "Failed to refresh schedules",
      message: error.message,
    });
  }
});

// Get current active code
app.get("/api/current-code", async (req, res) => {
  try {
    let currentCode = [];

    // Check Airbnb reservations
    for (const k in schedules) {
      if (
        moment().isBetween(
          new Date(schedules[k].start),
          new Date(schedules[k].end)
        )
      ) {
        currentCode = [
          schedules[k].phoneNumber,
          schedules[k].reservationNumber,
        ];
        break;
      }
    }

    // If no Airbnb reservation is active, check manual visits
    if (currentCode.length === 0) {
      const visits = await readScheduledVisits();
      const now = moment().tz(config.get("timezone"));

      for (const visit of visits) {
        // Only consider visits with phone numbers
        if (!visit.phone) continue;

        // Find checkin and checkout mode changes
        let checkinTime = null;
        let checkoutTime = null;

        for (const change of visit.modeChanges) {
          const changeTime = moment(change.time).tz(config.get("timezone"));
          if (change.mode === "checkin" && changeTime.isBefore(now)) {
            checkinTime = changeTime;
          }
          if (change.mode === "checkout" && changeTime.isAfter(now)) {
            checkoutTime = changeTime;
          }
        }

        // If we've checked in but haven't checked out yet, this code is active
        if (checkinTime && checkoutTime) {
          currentCode = [visit.phone, visit.name];
          break;
        }
      }
    }

    res.json({ currentCode });
  } catch (error) {
    log.error(`Error getting current code: ${error}`);
    res.status(500).json({ error: "Failed to get current code" });
  }
});

// Get all scheduled visits
app.get("/api/visits", async (req, res) => {
  try {
    log.debug("Fetching all scheduled visits...");
    const visits = await readScheduledVisits();
    log.debug(`Found ${visits.length} scheduled visits`);
    res.json(visits);
  } catch (error) {
    log.error(`Error fetching scheduled visits: ${error.message}`);
    res.status(500).json({
      error: "Failed to read scheduled visits",
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// Add a new scheduled visit
app.post("/api/visits", async (req, res) => {
  try {
    log.debug("Adding new scheduled visit:", req.body);
    const visit = await addScheduledVisit(req.body);
    log.debug("Successfully added visit:", visit);
    res.json(visit);
  } catch (error) {
    log.error(`Error adding scheduled visit: ${error.message}`);
    res.status(500).json({
      error: "Failed to save scheduled visit",
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// Delete a scheduled visit
app.delete("/api/visits/:id", async (req, res) => {
  try {
    log.debug(`Deleting scheduled visit ${req.params.id}`);
    await deleteScheduledVisit(req.params.id);
    log.debug("Successfully deleted visit");
    res.json({ success: true });
  } catch (error) {
    log.error(`Error deleting scheduled visit: ${error.message}`);
    res.status(500).json({
      error: "Failed to delete scheduled visit",
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// Config management endpoints
app.get("/api/config", async (req, res) => {
  try {
    log.debug("Loading configuration...");
    const configData = {
      ical_url: config.has("ical_url") ? config.get("ical_url") : "",
      houfy_ical_url: config.has("houfy_ical_url")
        ? config.get("houfy_ical_url")
        : "",
      arrivalScheduleTime: config.get("arrivalScheduleTime"),
      departureScheduleTime: config.get("departureScheduleTime"),
      arrivingSoonTime: config.get("arrivingSoonTime"),
      arrivingSoonDayOffset: config.get("arrivingSoonDayOffset"),
      checkin_mode: config.get("checkin_mode"),
      checkout_mode: config.get("checkout_mode"),
      arriving_soon_mode: config.get("arriving_soon_mode"),
      hubitat_ip: config.get("hubitat_ip"),
      hubitat_maker_api_access_token: config.get(
        "hubitat_maker_api_access_token"
      ),
      lock_code_slot: config.get("lock_code_slot"),
      locks_to_code: config.get("locks_to_code"),
      pushover: config.get("pushover"),
    };
    log.debug("Configuration loaded successfully");
    res.json(configData);
  } catch (error) {
    log.error(`Error reading config: ${error}`);
    res.status(500).json({
      error: "Failed to read configuration",
      details: error.message,
    });
  }
});

app.post("/api/config", async (req, res) => {
  try {
    const configData = req.body;

    // Read the current config file
    const configPath = path.join(
      __dirname,
      "config",
      `${process.env.NODE_ENV || "default"}.json`
    );
    const currentConfig = JSON.parse(await readFileAsync(configPath, "utf8"));

    // Update only the allowed fields
    const allowedFields = [
      "ical_url",
      "houfy_ical_url",
      "arrivalScheduleTime",
      "departureScheduleTime",
      "arrivingSoonTime",
      "arrivingSoonDayOffset",
      "checkin_mode",
      "checkout_mode",
      "arriving_soon_mode",
      "hubitat_ip",
      "hubitat_maker_api_access_token",
      "lock_code_slot",
      "locks_to_code",
      "pushover",
    ];

    allowedFields.forEach((field) => {
      if (field === "pushover") {
        currentConfig.pushover = configData.pushover;
      } else if (configData[field] !== undefined) {
        currentConfig[field] = configData[field];
      }
    });

    // Write back to the config file
    await writeFileAsync(configPath, JSON.stringify(currentConfig, null, 4));

    // Apply updated values to the in-memory config (node-config doesn't expose config.reload())
    allowedFields.forEach((field) => {
      if (field === "pushover") {
        config.pushover = currentConfig.pushover;
      } else if (currentConfig[field] !== undefined) {
        config[field] = currentConfig[field];
      }
    });

    res.json({ message: "Configuration updated successfully" });
  } catch (error) {
    log.error(`Error updating config: ${error}`);
    res.status(500).json({
      error: "Failed to update configuration",
      details: error.message,
    });
  }
});

// Add late check-out endpoint here, after app initialization but before server start
app.post(
  "/api/schedules/:reservationNumber/late-checkout",
  async (req, res) => {
    try {
      const { reservationNumber } = req.params;
      const { newCheckoutTime } = req.body;

      if (!newCheckoutTime) {
        return res
          .status(400)
          .json({ error: "New check-out time is required" });
      }

      // Validate the reservation exists
      if (!schedules[reservationNumber]) {
        return res.status(404).json({ error: "Reservation not found" });
      }

      // Validate the new check-out time is in the future
      const newTime = new Date(newCheckoutTime);
      if (newTime <= new Date()) {
        return res
          .status(400)
          .json({ error: "New check-out time must be in the future" });
      }

      // Validate the new check-out time is after the check-in time
      const checkInTime = new Date(schedules[reservationNumber].start);
      if (newTime <= checkInTime) {
        return res
          .status(400)
          .json({ error: "New check-out time must be after check-in time" });
      }

      log.info(
        `Updating check-out time for reservation ${reservationNumber} to ${formatDate(
          newTime
        )}`
      );

      // Load current late checkouts
      const lateCheckouts = await readLateCheckouts();

      // Update late checkouts
      lateCheckouts[reservationNumber] = newTime.toISOString();
      await writeLateCheckouts(lateCheckouts);

      // Cancel existing check-out schedule
      if (schedules[reservationNumber].endSchedule) {
        schedules[reservationNumber].endSchedule.cancel();
      }

      // Update the schedule
      schedules[reservationNumber].end = newTime.toISOString();

      // Create new check-out schedule
      schedules[reservationNumber].endSchedule = schedule.scheduleJob(
        newTime,
        ((context) => {
          runCheckOutActions(context.phoneNumber, context.reservationNumber);
        }).bind(null, {
          phoneNumber: schedules[reservationNumber].phoneNumber,
          reservationNumber: reservationNumber,
        })
      );

      // Send notification
      if (pushover) {
        await sendPushoverNotification(
          `Late check-out scheduled for reservation ${reservationNumber} to ${formatDate(
            newTime
          )}`
        );
      }

      res.json({
        message: "Check-out time updated successfully",
        newCheckoutTime: newTime.toISOString(),
      });
    } catch (error) {
      log.error(`Error updating check-out time: ${error}`);
      res.status(500).json({
        error: "Failed to update check-out time",
        details: error.message,
      });
    }
  }
);

// Start server
const PORT = config.get("port") || 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
  log.debug(`Server running at:`);
  log.debug(`- Local: http://localhost:${PORT}`);
  log.debug(`- Network: http://0.0.0.0:${PORT}`);
  log.debug(`- Timezone: ${config.get("timezone")}`);
  log.debug(`- Environment: ${process.env.NODE_ENV || "production"}`);
  log.debug(`- Config file: config/${process.env.NODE_ENV || "default"}.json`);
  log.debug(`- Arriving Soon Time: ${config.get("arrivingSoonTime")}`);
  log.debug(
    `- Arriving Soon Day Offset: ${config.get("arrivingSoonDayOffset")}`
  );
  log.debug(`- Arriving Soon Mode: ${config.get("arriving_soon_mode")}`);
  initFileWatcher();
});

log.debug("Setting up cron job to check calendar");

(async function () {
  // Schedule the calendar check
  schedule.scheduleJob(config.get("cron_schedule"), async () => {
    await getSchedules();
  });

  // Initial setup
  await getSchedules(true);
  await initializeScheduledVisits();
})();

// Clean up file watcher when the server shuts down
process.on("SIGTERM", () => {
  if (scheduledVisitsWatcher) {
    scheduledVisitsWatcher.close();
  }
  server.close(() => {
    process.exit(0);
  });
});

// Function to send Pushover notification
const sendPushoverNotification = async (
  message,
  title = "Airbnb Scheduler"
) => {
  if (!pushover) {
    log.error("Pushover not initialized, skipping notification");
    return;
  }

  try {
    return new Promise((resolve, reject) => {
      pushover.send(
        {
          title: title,
          message: message,
          priority: 1,
          sound: "cosmic",
        },
        (err) => {
          if (err) {
            log.error(`Pushover notification error: ${err}`);
            reject(err);
          } else {
            log.debug("Pushover notification sent successfully");
            resolve();
          }
        }
      );
    });
  } catch (error) {
    log.error(`Error sending Pushover notification: ${error}`);
    throw error;
  }
};

app.get("/api/modes", async (req, res) => {
  try {
    const modes = await axios.get(getHubitatUrl("modes"));
    res.json(modes.data);
  } catch (error) {
    log.error(`Error getting modes: ${error}`);
    res.status(500).json({
      error: "Failed to get modes",
      details: error.message,
    });
  }
});

app.post("/api/modes/:modeId", async (req, res) => {
  try {
    await axios.get(getHubitatUrl(`modes/${req.params.modeId}`));
    res.json({ message: "Mode changed successfully" });
  } catch (error) {
    log.error(`Error setting mode: ${error}`);
    res.status(500).json({
      error: "Failed to set mode",
      details: error.message,
    });
  }
});
