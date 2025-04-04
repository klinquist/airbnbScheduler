const { default: axios } = require("axios");
const ical = require("ical"),
  async = require("async"),
  moment = require("moment-timezone"),
  config = require("config"),
  schedule = require("node-schedule"),
  retry = require("async-retry");

let pushover, p;
if (config.has("pushover")) {
  pushover = require("pushover-notifications");
  p = new pushover({
    user: config.get("pushover.user"),
    token: config.get("pushover.token"),
  });
}

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

const sendPush = (msg) => {
  if (config.has("pushover")) {
    p.send(
      {
        message: msg,
        title: "Airbnb Lock Code", // optional
        sound: "magic",
        priority: 1,
      },
      (err, res) => {
        if (err) {
          log.error(err);
        }
      }
    );
  }
};

const log = {
  debug: (msg) => {
    const now = moment().format("Y-MM-DD h:mm A");
    console.log(`${now} - DEBUG: ${msg}`);
  },
  info: (msg) => {
    const now = moment().format("Y-MM-DD h:mm A");
    console.log(`${now} - INFO: ${msg}`);
    sendPush(msg);
  },
  error: (msg) => {
    const now = moment().format("Y-MM-DD h:mm A");
    console.log(`${now} - ERROR: ${msg}`);
    sendPush(msg);
  },
};

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

  let currentCode = [];
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

log.debug("Setting up cron job to check calendar");

(async function () {
  schedule.scheduleJob(config.get("cron_schedule"), async () => {
    await getSchedules();
  });
  await getSchedules(true);
})();
