const {
    default: axios
} = require('axios');
const ical = require('ical'),
    async = require('async'),
        moment = require('moment-timezone'),
        config = require('config'),
        schedule = require('node-schedule'),
        retry = require('async-retry')



let pushover, p
if (config.has('pushover')) {
    pushover = require('pushover-notifications')
    p = new pushover({ user: config.get('pushover.user'), token: config.get('pushover.token') });
}


let LOCK_CODE_SLOT = config.get('lock_code_slot')
if (typeof LOCK_CODE_SLOT == 'number') { LOCK_CODE_SLOT = LOCK_CODE_SLOT.toString() }
const HUBITAT_IP = config.get('hubitat_ip');
const HUBITAT_ACCESS_TOKEN = config.get('hubitat_maker_api_access_token')
const locksToCode = config.get('locks_to_code')


const getHubitatUrl = (path) => {
    return `http://${HUBITAT_IP}/apps/api/9/${path}?access_token=${HUBITAT_ACCESS_TOKEN}`;
}


const sleep = ms => new Promise(r => setTimeout(r, ms));


const sendPush = (msg) => {
    if (config.has('pushover')) {
        p.send({
            message: msg,
            title: "Airbnb Lock Code", // optional
            sound: 'magic',
            priority: 1
        }, (err, res) => {
            if (err) {
                log.error(err)
            }
        })
    }
}


const log = {
    debug: (msg) => {
        const now = moment().format('Y-MM-DD h:mm A');
        console.log(`${now} - DEBUG: ${msg}`);
    },
    info: (msg) => {
        const now = moment().format('Y-MM-DD h:mm A');
        console.log(`${now} - INFO: ${msg}`);
        sendPush(msg)

    },
    error: (msg) => {
        const now = moment().format('Y-MM-DD h:mm A');
        console.log(`${now} - ERROR: ${msg}`);
        sendPush(msg)
    }
};


const setMode = async (modeName) => {
    let modes;
    try {
        modes = await axios.get(getHubitatUrl('modes'))
    } catch (err) {
        throw new Error(err)
    }

    let mode = modes.data.find(n => n.name.toUpperCase() == modeName.toUpperCase())
    if (!mode) return log.error(`Could not find mode ${modeName}`)

    if (mode.active) {
        return log.info(`Mode ${modeName} is already active.`)
    }
    try {
        await axios.get(getHubitatUrl(`modes/${mode.id}`))
    } catch (e) {
        throw new Error(err)
    }
    log.info(`Successfully set mode to ${modeName}`)
}


const setLockCode = async (phoneNumber, reservationNumber) => {
    let locks;
    try {
        locks = await axios.get(getHubitatUrl('devices'))
    } catch (e) {
        throw new Error(`Error getting list of devices: ${e.message}`)
    }

    locks = locks.data.filter(n => locksToCode.includes(n.label))

    let lockCodeBody = [
        LOCK_CODE_SLOT,
        phoneNumber,
        reservationNumber
    ].join(',')

    const serialLoopFlow = async (locks) => {
        for (const lock in locks) {
            await setLockWithRetry(locks[lock], lockCodeBody, phoneNumber)
        }
    }
    await serialLoopFlow(locks)
}


const setLockWithRetry = async (lock, lockCodeBody, phoneNumber) => {
    await retry(
        async (bail) => {
            // if anything throws, we retry
            await axios.get(getHubitatUrl(`devices/${lock.id}/setCode/${lockCodeBody}`)).then(() => {
                log.debug(`Programmed code ${phoneNumber} on lock ${lock.name}`)
            }).catch((err) => {
                log.debug(`Error setting code on lock ${lock.name}: ${err}`)
            })
            log.debug('Waiting 5 seconds and asking the lock to refresh')
            await sleep(5000)
            await (getHubitatUrl(`devices/${lock.id}/refresh`))
            await sleep(5000)
            log.debug('Getting lock codes')
            let lockData = await axios.get(getHubitatUrl(`devices/${lock.id}/getCodes`)).catch((err) => {
                log.error(err)
            })
            let attrib;
            try {
                attrib = JSON.parse(lockData.data.attributes.find(n => n.name == 'lockCodes').currentValue)
            } catch (e) {
                log.error(`Error parsing lock codes: ${e}`)
                return bail()
            }
            attrib = attrib[LOCK_CODE_SLOT] && attrib[LOCK_CODE_SLOT].code
            if (attrib !== phoneNumber) {
                log.error(`Lock code not set correctly on lock ${lock.name}, retrying`)
                throw new Error()
            }
            log.info(`Successfully set code ${phoneNumber} on lock ${lock.label}`)
        }, {
            retries: 3,
            minTimeout: 60000
        }
    );
}


const removeLockCode = async (phoneNumber) => {

    let locks;
    try {
        locks = await axios.get(getHubitatUrl('devices'))
    } catch (e) {
        throw new Error(`Error getting list of devices ${e}`)
    }

    locks = locks.data.filter((n) => {
        return locksToCode.includes(n.label)
    })


    const serialLoopFlow = async (locks) => {
        for (const lock in locks) {
            await axios.get(getHubitatUrl(`devices/${locks[lock].id}/deleteCode/${LOCK_CODE_SLOT}`)).then(() => {
                    log.info(`Successfully removed code ${phoneNumber} from lock ${locks[lock].label}`)
                }).catch((err) => {
                    log.error(`Error setting code on lock ${locks[lock].name}: ${err}`)
                })
            }
    }
    
    await serialLoopFlow(locks)

}


const schedules = {};


const convertStrToDate = (str) => {
    str = str.replace(/\s/g, '').toUpperCase();
    const match = str.match(/(\d+):(\d+)(A|P)?/);
    if (!match || !match[1] || !match[2]) throw new Error(`Could not convert time to cron format: ${str}`);
    let hr;
    if (match[3] == 'A' && Number(match[1]) == 12) {
        hr = 0;
    } else if (match[3] == 'P' && Number(match[1]) < 12) {
        hr = Number(match[1]) + 12;
    } else {
        hr = Number(match[1]);
    }
    return {
        hr,
        min: Number(match[2]),
        sec: '0'
    };
};


const getiCalEvents = async () => {
    const events = [];

    const airbnb_ical = await axios.get(config.get('ical_url')).catch((err) => {
        return log.error(`Error getting iCal: ${err}`)
    })

    if (!airbnb_ical || typeof airbnb_ical.data == 'undefined') {
        return log.error('No iCal data found')
    }
    
    let data = ical.parseICS(airbnb_ical.data)

    if (!data || Object.keys(data) == 0) {
        return log.debug("No reservations found")
    }
    for (const k in data) {
        if (data.hasOwnProperty(k)) {
            var ev = data[k];
            if (ev && ev.start && ev.summary && ev.summary !== 'Airbnb (Not available)') {
                events.push(ev);
            }
        }
    }
    log.debug(`Found ${events.length} upcoming reservations in airbnb calendar.`);
    return events
};



const runCheckInActions = async (ph, reservationNumber) => {
    log.info('Running check in actions')
    try {
        await setLockCode(ph, reservationNumber)
    } catch (err) {
        log.error(`Error setting lock code: ${err}`)
    }

    let mode = config.get('checkin_mode')
    if (mode) {
        try {
            await setMode(mode)
        } catch (err) {
            log.error(`Error setting mode: ${err}`)
        }
    }
};


const runCheckOutActions = async (ph, reservationNumber) => {
    log.info('Running check out actions')
    try {
        await removeLockCode(ph)
    } catch (err) {
        log.error(`Error removing lock code: ${err}`)
    }
    let mode = config.get('checkout_mode')
    if (mode) {
        try {
            await setMode(mode)
        } catch (err) {
            log.error(`Error setting mode: ${err}`)
        }
    }
};


const runArrivingSoonActions = async (ph, reservationNumber) => {
    let mode = config.get('arriving_soon_mode')
    if (mode) {
        try {
            await setMode(mode)
        } catch (err) {
            log.error(`Error setting mode: ${err}`)
        }
    } else {
        log.error(`No arriving_soon_mode set in config`)
    }
}


const dateInPast = function (firstDate) {
    return firstDate.getTime() < new Date().getTime()
};


const startSchedule = (sched) => {

    if (!dateInPast(new Date(sched.start))) {
        log.debug(`Scheduling checkin actions at ${sched.start} for reservation ${sched.reservationNumber}`)
        sched.startSchedule = schedule.scheduleJob(new Date(sched.start), ((context) => {
            runCheckInActions(context.phoneNumber, context.reservationNumber);
        }).bind(null, {
            phoneNumber: sched.phoneNumber,
            reservationNumber: sched.reservationNumber
        }));
    } else {
        log.debug(`Skipping scheduling start date - it's in the past`);
    }

    if (!dateInPast(new Date(sched.end))) {
        log.debug(`Scheduling checkout actions at ${sched.end} for reservation ${sched.reservationNumber}`);
        sched.endSchedule = schedule.scheduleJob(new Date(sched.end), ((context) => {
            runCheckOutActions(context.phoneNumber, context.reservationNumber);
        }).bind(null, {
            phoneNumber: sched.phoneNumber,
            reservationNumber: sched.reservationNumber
        }));
    } else {
        log.debug(`Skipping scheduling end date - it's in the past`);
    }

    if (sched.arriving) {
        if (!dateInPast(new Date(sched.arriving))) {
            log.debug(`Scheduling arriving soon actions at ${sched.arriving} for reservation ${sched.reservationNumber}`);
            sched.arrivingSoonSchedule = schedule.scheduleJob(new Date(sched.arriving), ((context) => {
                runArrivingSoonActions(context.phoneNumber, context.reservationNumber);
            }).bind(null, {
                phoneNumber: sched.phoneNumber,
                reservationNumber: sched.reservationNumber
            }));
        } else {
            log.debug(`Skipping scheduling arrivingSoon date - it's in the past`);
        }
    }
};




const getSchedules = async (firstRun) => {
    log.debug('Refreshing schedules');

    const events = await getiCalEvents().catch((err) => {
        throw new Error(err)
    })

    let currentCode = []
    const currentSchedules = [];
    for (let i = 0; i < events.length; i++) {



        const timeStart = convertStrToDate(config.get('arrivalScheduleTime'));
        const timeEnd = convertStrToDate(config.get('departureScheduleTime'));
        const dateStart = new Date(events[i].start.getUTCFullYear(), events[i].start.getMonth(), events[i].start.getDate(), timeStart.hr, timeStart.min, timeStart.sec);
        const dateEnd = new Date(events[i].end.getUTCFullYear(), events[i].end.getMonth(), events[i].end.getDate(), timeEnd.hr, timeEnd.min, timeEnd.sec);
        const reservationNumber = events[i].description.match(/([A-Z0-9]{9,})/g)[0];

        const phoneNumber = events[i].description.match(/\s([0-9]{4})/)[1];


        let arrivingSoonStart, arrivingSoonDate
        if (config.get('arrivingSoonTime')) {
            arrivingSoonStart = convertStrToDate(config.get('arrivingSoonTime'));
            arrivingSoonDate = new Date(events[i].start.getUTCFullYear(), events[i].start.getMonth(), events[i].start.getDate(), arrivingSoonStart.hr, arrivingSoonStart.min, arrivingSoonStart.sec);
            if (config.get('arrivingSoonDayOffset')) {
                arrivingSoonDate = new Date(arrivingSoonDate.setDate(arrivingSoonDate.getDate() + (config.get('arrivingSoonDayOffset'))));
            }
        }


        if (!schedules[reservationNumber]) {
            let logMessage = 'Scheduling new reservation ' + reservationNumber + ' for ' + dateStart.toISOString() + ' to ' + dateEnd.toISOString();
            if (!firstrun) {
                // info to send push notification if this isn't on first run/startup
                log.info(logMessage)
            } else {
                log.debug(logMessage)
            }
            let sched = {
                start: dateStart.toISOString(),
                end: dateEnd.toISOString(),
                phoneNumber,
                reservationNumber: reservationNumber
            }
            if (arrivingSoonDate) {
                sched.arriving = arrivingSoonDate.toISOString()
            }
            schedules[reservationNumber] = sched
            startSchedule(schedules[reservationNumber]);
        }

        if (schedules[reservationNumber].start !== dateStart.toISOString() || schedules[reservationNumber].end !== dateEnd.toISOString()) {
            log.debug('Schedule for ' + reservationNumber + ' changed! Updating schedule');
            if (schedules[reservationNumber].arrivingSoonSchedule) schedules[reservationNumber].arrivingSoonSchedule.cancel();
            if (schedules[reservationNumber].startSchedule) schedules[reservationNumber].startSchedule.cancel();
            if (schedules[reservationNumber].endSchedule) schedules[reservationNumber].endSchedule.cancel();
            schedules[reservationNumber] = {
                start: dateStart.toISOString(),
                end: dateEnd.toISOString(),
                phoneNumber,
                reservationNumber: reservationNumber
            };
            if (arrivingSoonDate) {
                schedules[reservationNumber].arriving = arrivingSoonDate.toISOString()
            }
            startSchedule(schedules[reservationNumber]);
        }


        if (moment().isBetween(dateStart, dateEnd)) {
            currentCode = [phoneNumber, reservationNumber]
        }

        currentSchedules.push(reservationNumber);

    }

    //Check for schedules that need to be removed!

    for (const k in schedules) {
        if (currentSchedules.indexOf(k) == -1) {
            log.info('Reservation ' + k + ' has been deleted, removing the schedule!');
            if (schedules[k].startSchedule) schedules[k].startSchedule.cancel();
            if (schedules[k].endSchedule && dateInPast(new Date(schedules[k].end))) schedules[k].endSchedule.cancel();

            if (moment().isBetween(schedules[k].startSchedule, schedules[k].endSchedule)) {
                if (config.get('run_checkout_immediately_if_reservation_is_cancelled_mid_stay')) {
                    log.info('Reservation ' + k + ' is currently active but has been canceled, removing lock code and running checkout actions');
                    runCheckOutActions(schedules[k].phoneNumber, schedules[k].reservationNumber);
                    schedules[k].endSchedule.cancel();
                    delete schedules[k];
                } else {
                    log.info('Reservation ' + k + ' is currently active but has been canceled, check out actions will run at normally scheduled time');
                }
            } else {
                delete schedules[k];
            }
        }
    }

    if (currentCode.length == 0) {
        log.debug('There should be zero codes programmed in the lock right now.');
    } else {
        log.debug('The following code should be active: ' + currentCode[0]);
    }
};



log.debug('Setting up cron job to check calendar');




(async function () {
    schedule.scheduleJob(config.get('cron_schedule'), async () => {
        await getSchedules();
    });
    await getSchedules(true);
})()