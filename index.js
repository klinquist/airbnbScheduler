const {
    default: axios
} = require('axios');
const ical = require('ical'),
    async = require('async'),
        moment = require('moment-timezone'),
        config = require('config'),
        schedule = require('node-schedule'),
        request = require('axios')


const LOCK_CODE_SLOT = config.get('lock_code_slot')
const HUBITAT_IP = config.get('hubitat_ip');
const HUBITAT_ACCESS_TOKEN = config.get('hubitat_maker_api_access_token')
const locksToCode = config.get('locks_to_code')


const getHubitatUrl = (path) => {
    return `http://${HUBITAT_IP}/apps/api/9/${path}?access_token=${HUBITAT_ACCESS_TOKEN}`;
}


const log = (logMsg) => {
    const now = moment().format('Y-MM-DD h:mm A');
    console.log(`${now} - ${logMsg}`);
};

const setMode = async (modeName) => {
    let modes = await axios.get(getHubitatUrl('modes')).catch((err) => {
        throw new Error(`Error getting modes: ${err}`)
    })
    let mode = modes.data.find((n) => {
        n.name == modeName
    })
    if (!mode) throw new Error(`Could not find mode ${modeName}`)
    await axios.get(getHubitatUrl(`modes/${mode.id}/activate`)).then(() => {
        log(`Successfully set mode to ${modeName}`)
    }).catch((err) => {
        throw new Error(`Error setting mode: ${err}`)
    })

}


const setLockCode = async (phoneNumber, reservationNumber) => {
    let locks = axios.get(getHubitatUrl('devices')).catch((err) => {
        throw new Error(`Error getting list of devices`)
    })
    locks = locks.data.filter((n) => {
        return locksToCode.includes(n.label)
    })
    let lockCodeBody = [
        LOCK_CODE_SLOT,
        phoneNumber,
        reservationNumber
    ].join(',')

    await Promise.all(
        locks.map(async (lock) => {
            await axios.get(`devices/${lock.id}/setCode/${lockCodeBody}`).then(() => {
                log(`Successfully programmed code ${phoneNumber} on lock ${lock.name}`)
            }).catch((err) => {
                log(`Error setting code on lock ${lock.name}: ${err}`)
            })
        })
    )
}


const removeLockCode = async (phoneNumber, reservationNumber) => {
    let locks = axios.get(getHubitatUrl('devices')).catch((err) => {
        throw new Error(`Error getting list of devices`)
    })
    locks = locks.data.filter((n) => {
        return locksToCode.includes(n.label)
    })
    for await (const lock of locks) {
        await axios.get(`devices/${lock.id}/deleteCode/${LOCK_CODE_SLOT}`).then(() => {
            log(`Successfully removed code ${phoneNumber} on lock ${lock.name}`)
        }).catch((err) => {
            log(`Error removing code on lock ${lock.name}: ${err}`)
        })
    }
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
        log(`Error getting iCal: ${err}`)
    })

    let data = await ical.parseICS(airbnb_ical.data)

    if (!data || Object.keys(data) == 0) {
        return cb('No events returned');
    }
    for (const k in data) {
        if (data.hasOwnProperty(k)) {
            var ev = data[k];
            if (ev && ev.start && ev.summary && ev.summary !== 'Airbnb (Not available)') {
                events.push(ev);
            }
        }
    }
    log(`Found ${events.length} events in airbnb calendar.`);
    return events
};



const runCheckInActions = async (ph, reservationNumber) => {
    await setLockCode(ph, reservationNumber, cb).catch((err) => {
        throw new Error(err)
    })
    let mode = config.get('checkin_mode')
    if (mode) {
        await setMode(mode).catch((err) => {
            throw new Error(err)
        })
    }
};


const runCheckOutActions = async (ph, reservationNumber) => {
    await removeLockCode(ph, reservationNumber, cb).catch((err) => {
        throw new Error(err)
    })
    let mode = config.get('checkout_mode')
    if (mode) {
        await setMode(mode).catch((err) => {
            throw new Error(err)
        })
    }
};


const dateInPast = function (firstDate) {
    if (firstDate.setHours(0, 0, 0, 0) <= new Date().setHours(0, 0, 0, 0)) {
        return true;
    }
    return false;
};


const startSchedule = (sched) => {

    if (!dateInPast(new Date(sched.start))) {
        sched.startSchedule = schedule.scheduleJob(new Date(sched.start), ((context) => {
            runCheckInActions(context.phoneNumber, context.reservationNumber);
        }).bind(null, {
            phoneNumber: sched.phoneNumber,
            reservationNumber: sched.reservationNumber
        }));
    } else {
        log(`Skipping scheduling start date - it's in the past`);
    }

    if (!dateInPast(new Date(sched.end))) {
        sched.endSchedule = schedule.scheduleJob(new Date(sched.end), ((context) => {
            runCheckOutActions(context.phoneNumber, context.reservationNumber);
        }).bind(null, {
            phoneNumber: sched.phoneNumber,
            reservationNumber: sched.reservationNumber
        }));
    } else {
        log(`Skipping scheduling end date - it's in the past`);
    }
};




const getSchedules = async () => {
    log('Refreshing schedules');

    const events = await getiCalEvents().catch((err) => {
        throw new Error(err)
    })

    const currentCode = []
    const currentSchedules = [];
    for (let i = 0; i < events.length; i++) {

        const timeStart = convertStrToDate(config.get('arrivalScheduleTime'));
        const timeEnd = convertStrToDate(config.get('departureScheduleTime'));
        const dateStart = new Date(events[i].start.getUTCFullYear(), events[i].start.getMonth(), events[i].start.getDate(), timeStart.hr, timeStart.min, timeStart.sec);
        const dateEnd = new Date(events[i].end.getUTCFullYear(), events[i].end.getMonth(), events[i].end.getDate(), timeEnd.hr, timeEnd.min, timeEnd.sec);
        const reservationNumber = events[i].description.match(/([A-Z0-9]{9,})/g)[0];

        const phoneNumber = events[i].description.match(/\s([0-9]{4})/)[1];

        if (!schedules[reservationNumber]) {
            log('Scheduling new reservation ' + reservationNumber);
            schedules[reservationNumber] = {
                start: dateStart.toISOString(),
                end: dateEnd.toISOString(),
                phoneNumber,
                reservationNumber: reservationNumber
            };
            startSchedule(schedules[reservationNumber]);
        }

        if (schedules[reservationNumber].start !== dateStart.toISOString() || schedules[reservationNumber].end !== dateEnd.toISOString()) {
            log('Schedule for ' + reservationNumber + ' changed! Updating schedule');
            if (schedules[reservationNumber].startSchedule) schedules[reservationNumber].startSchedule.cancel();
            if (schedules[reservationNumber].endSchedule) schedules[reservationNumber].endSchedule.cancel();
            schedules[reservationNumber] = {
                start: dateStart.toISOString(),
                end: dateEnd.toISOString(),
                phoneNumber,
                reservationNumber: reservationNumber
            };
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
            console.log('Reservation ' + k + ' has been deleted, removing the schedule!');
            if (schedules[k].startSchedule) schedules[k].startSchedule.cancel();
            if (schedules[k].endSchedule) schedules[k].endSchedule.cancel();
            delete schedules[k];
        }
    }

    if (currentCode.length == 0) {
        log('There should be zero codes programmed in the lock right now.');
    } else {
        log('The following code should be active: ' + currentCode[0]);
    }
};



log('Setting up cron job to check calendar');





(async function () {
    schedule.scheduleJob(config.get('cron_schedule'), async () => {
        await getSchedules();
    });
    await getSchedules();
})()