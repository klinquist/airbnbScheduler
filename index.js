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

let LOCK_CODE_SLOT = config.get("lock_code_slot");
if (typeof LOCK_CODE_SLOT == "number") {
  LOCK_CODE_SLOT = LOCK_CODE_SLOT.toString();
}
const HUBITAT_IP = config.get("hubitat_ip");
const HUBITAT_ACCESS_TOKEN = config.get("hubitat_maker_api_access_token");
const locksToCode = config.get("locks_to_code");

const getHubitatUrl = (path) => {
  return `http://${HUBITAT_IP}/apps/api/9/${path}?access_token=${HUBITAT_ACCESS_TOKEN}`;
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

const setMode = async (modeName) => {
  let modes;
  try {
    modes = await axios.get(getHubitatUrl("modes"));
  } catch (err) {
    throw new Error(err);
  }

  let mode = modes.data.find(
    (n) => n.name.toUpperCase() == modeName.toUpperCase()
  );
  if (!mode) return log.error(`Could not find mode ${modeName}`);

  if (mode.active) {
    return log.info(`Mode ${modeName} is already active.`);
  }
  try {
    await axios.get(getHubitatUrl(`modes/${mode.id}`));
  } catch (e) {
    throw new Error(err);
  }
  log.info(`Successfully set mode to ${modeName}`);
};

const setLockCode = async (phoneNumber, reservationNumber) => {
  let locks;
  try {
    locks = await axios.get(getHubitatUrl("devices"));
  } catch (e) {
    throw new Error(`Error getting list of devices: ${e.message}`);
  }

  locks = locks.data.filter((n) => locksToCode.includes(n.label));

  let lockCodeBody = [LOCK_CODE_SLOT, phoneNumber, reservationNumber].join(",");

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
      attrib = attrib[LOCK_CODE_SLOT] && attrib[LOCK_CODE_SLOT].code;
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

  locks = locks.data.filter((n) => {
    return locksToCode.includes(n.label);
  });

  const serialLoopFlow = async (locks) => {
    for (const lock in locks) {
      await axios
        .get(
          getHubitatUrl(
            `devices/${locks[lock].id}/deleteCode/${LOCK_CODE_SLOT}`
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

const getiCalEvents = async () => {
  const events = [];

  const airbnb_ical = await axios.get(config.get("ical_url")).catch((err) => {
    return log.error(`Error getting iCal: ${err}`);
  });

  if (!airbnb_ical || typeof airbnb_ical.data == "undefined") {
    return log.error("No iCal data found");
  }

  let data = ical.parseICS(airbnb_ical.data);

  if (!data || Object.keys(data) == 0) {
    return log.debug("No reservations found");
  }
  for (const k in data) {
    if (data.hasOwnProperty(k)) {
      var ev = data[k];
      if (
        ev &&
        ev.start &&
        ev.summary &&
        ev.summary !== "Airbnb (Not available)"
      ) {
        events.push(ev);
      }
    }
  }
  log.debug(`Found ${events.length} upcoming reservations in airbnb calendar.`);
  return events;
};

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
      await setMode(mode);
    } catch (err) {
      log.error(`Error setting mode: ${err}`);
    }
  }
};

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
      await setMode(mode);
    } catch (err) {
      log.error(`Error setting mode: ${err}`);
    }
  }
};

const runArrivingSoonActions = async (ph, reservationNumber) => {
  let mode = config.get("arriving_soon_mode");
  if (mode) {
    try {
      await setMode(mode);
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
  }
};

const getSchedules = async (firstRun) => {
  log.debug("Refreshing schedules");

  const events = await getiCalEvents().catch((err) => {
    throw new Error(err);
  });

  if (!events) {
    return log.error("No events found");
  }

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
    const dateEnd = new Date(
      events[i].end.getUTCFullYear(),
      events[i].end.getMonth(),
      events[i].end.getDate(),
      timeEnd.hr,
      timeEnd.min,
      timeEnd.sec
    );
    const reservationNumber = events[i].description.match(/([A-Z0-9]{9,})/g)[0];
    const phoneNumber = events[i].description.match(/\s([0-9]{4})/)[1];

    let arrivingSoonStart, arrivingSoonDate;
    if (config.get("arrivingSoonTime")) {
      arrivingSoonStart = convertStrToDate(config.get("arrivingSoonTime"));
      if (config.get("arrivingSoonDayOffset")) {
        arrivingSoonDate = new Date(
          arrivingSoonDate.setDate(
            arrivingSoonDate.getDate() + config.get("arrivingSoonDayOffset")
          )
        );
      }
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
      if (!firstRun) {
        log.info(logMessage);
      } else {
        log.debug(logMessage);
      }
      let sched = {
        start: dateStart.toISOString(),
        end: dateEnd.toISOString(),
        phoneNumber,
        reservationNumber: reservationNumber,
      };
      if (arrivingSoonDate) {
        sched.arriving = arrivingSoonDate.toISOString();
      }
      schedules[reservationNumber] = sched;
      startSchedule(schedules[reservationNumber]);
    }

    if (
      schedules[reservationNumber].start !== dateStart.toISOString() ||
      schedules[reservationNumber].end !== dateEnd.toISOString()
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

const SCHEDULED_VISITS_FILE = "scheduled_visits.json";
const scheduledVisitJobs = new Map(); // Store cron jobs for scheduled visits

// Add file watcher for scheduled visits file
let scheduledVisitsWatcher = null;
let scheduledVisitsCache = null;
let lastWriteTime = 0;
const WRITE_COOLDOWN = 1000; // 1 second cooldown between writes

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
      log.debug("Scheduled visits file modified externally");
      scheduledVisitsCache = null; // Invalidate cache
    });

    scheduledVisitsWatcher.on("error", (error) => {
      log.error(`File watcher error: ${error}`);
    });
  } catch (error) {
    log.error(`Failed to initialize file watcher: ${error}`);
  }
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

// Modified writeScheduledVisits function with change detection
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

    // Write new data
    await writeFileAsync(filePath, JSON.stringify(visits, null, 2));
    lastWriteTime = now;

    // Update cache
    scheduledVisitsCache = visits;

    log.debug("Successfully wrote scheduled visits to file");
  } catch (error) {
    log.error(`Error writing scheduled visits: ${error}`);
    throw error;
  }
};

// Modified scheduleVisit function to use optimized file operations
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
  const jobs = visit.modeChanges.map(async (change) => {
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
        log.info(
          `Executing mode change for visit ${
            visit.id
          } - Setting mode to ${mode} at ${moment(changeDate).format(
            "MMM D, YYYY h:mm A z"
          )}`
        );
        await setMode(mode);
        log.info(
          `Successfully set mode to ${mode} for visit ${visit.id} at ${moment(
            changeDate
          ).format("MMM D, YYYY h:mm A z")}`
        );

        // If this is the first mode change and phone number is provided, set the lock code
        if (visit.phone && change === visit.modeChanges[0]) {
          try {
            await setLockCode(visit.phone, `Manual Visit - ${visit.name}`);
            log.info(`Successfully set lock code for visit ${visit.id}`);
          } catch (err) {
            log.error(`Error setting lock code for visit ${visit.id}: ${err}`);
          }
        }

        // If this is the last mode change, clean up
        if (change === visit.modeChanges[visit.modeChanges.length - 1]) {
          // Remove the visit from the file
          const visits = await readScheduledVisits();
          const updatedVisits = visits.filter((v) => v.id !== visit.id);
          await writeScheduledVisits(updatedVisits);
          log.debug(`Removed completed visit ${visit.id} from storage`);

          // Remove the jobs from our map
          scheduledVisitJobs.delete(visit.id);
          log.debug(`Cleaned up jobs for visit ${visit.id}`);
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
  res.json(schedules);
});

// Get current active code
app.get("/api/current-code", (req, res) => {
  try {
    let currentCode = [];
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
    log.debug(`Deleting scheduled visit with ID: ${req.params.id}`);
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

    // Reload the config
    config.reload();

    res.json({ message: "Configuration updated successfully" });
  } catch (error) {
    log.error(`Error updating config: ${error}`);
    res.status(500).json({
      error: "Failed to update configuration",
      details: error.message,
    });
  }
});

// Start server
const PORT = config.get("port") || 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
  log.debug(`Server running at:`);
  log.debug(`- Local: http://localhost:${PORT}`);
  log.debug(`- Network: http://0.0.0.0:${PORT}`);
  log.debug(`- Timezone: ${config.get("timezone")}`);
  log.debug(`- Environment: ${process.env.NODE_ENV || "production"}`);
  initFileWatcher();
});

log.debug("Setting up cron job to check calendar");

(async function () {
  // Schedule the calendar check
  schedule.scheduleJob(config.get("cron_schedule"), async () => {
    await getSchedules();
    await initializeScheduledVisits(); // Also reinitialize scheduled visits
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
