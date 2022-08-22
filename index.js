const ical = require('ical'),
    async = require('async'),
        moment = require('moment-timezone'),
        config = require('config'),
        schedule = require('node-schedule'),
        request = require('request')


const LOCK_CODE_SLOT = config.get('lock_code_slot')
const HUBITAT_IP = config.get('hubitat_ip');
const HUBITAT_ACCESS_TOKEN = config.get('hubitat_maker_api_access_token')
const locksToCode = config.get('locks_to_code')


const getHubitatUrl = (path) => {
    return `http://${HUBITAT_IP}/apps/api/9/${path}?access_token=${HUBITAT_ACCESS_TOKEN}`;
}


const setMode = (modeName, cb) => {
    async.waterfall([
            async.waterfall([
                (cb) => {
                    let requestObj = {
                        method: 'GET',
                        url: getHubitatUrl('modes'),
                        json: true
                    }
                    request(requestObj, (err, res, body) => {
                        if (err) return cb(`Error getting modes ${err}`)
                        let mode = body.find((n) => { n.name == modeName })
                        if (!mode) return cb(`Could not find mode ${modeName}`)
                        return cb(null, mode)
                    })
                },
                (mode, cb) => {
                    
                    let requestObj = {
                        method: 'GET',
                        url: getHubitatUrl(`modes/${mode.id}`),
                        json: true
                    }
                    log(`Setting mode to ${mode.name}`)
                    request(requestObj, (err, res, body) => {
                        if (err) return cb(err)
                        return cb()
                    })
                }
            ], cb)
    ])
}



const setLockCode = (phoneNumber, reservationNumber, cb) => {
    async.waterfall([
        (cb) => {
            let requestObj = {
                method: 'GET',
                url: getHubitatUrl('devices'),
                json: true
            }
            request(requestObj, (err, res, body) => {
                if (err) return cb(`Error getting list of devices`)
                let locks = body.filter((n) => {
                    return locksToCode.includes(n.label)
                })
                return cb(null, locks)
            })
        },
        (locks, cb) => {
            let lockCodeBody = [
                LOCK_CODE_SLOT,
                phoneNumber,
                reservationNumber
            ].join(',')
            async.eachSeries(locks, (lock, cb) => {
                let requestObj = {
                    method: 'GET',
                    url: getHubitatUrl(`devices/${lock.id}/setCode/${lockCodeBody}`),
                    json: true
                }
                log(`Setting code on lock ${lock.name}`)
                request(requestObj, (err, res, body) => {
                    console.log(body)
                    return cb()
                })
            }, cb)
        }
    ], cb)
}


const removeLockCode = (phoneNumber, reservationNumber, cb) => {
    async.waterfall([
        (cb) => {
            let requestObj = {
                method: 'GET',
                url: getHubitatUrl('devices'),
                json: true
            }
            request(requestObj, (err, res, body) => {
                if (err) return cb(`Error getting list of devices`)
                let locks = body.filter((n) => {
                    return locksToCode.includes(n.label)
                })
                return cb(null, locks)
            })
        },
        (locks, cb) => {
            async.eachSeries(locks, (lock, cb) => {
                let requestObj = {
                    method: 'GET',
                    url: getHubitatUrl(`devices/${lock.id}/deleteCode/${LOCK_CODE_SLOT}`),
                    json: true
                }
                log(`Deleting code ${phoneNumber} on lock ${lock.name}`)
                request(requestObj, (err, res, body) => {
                    if (err) return cb(`Error removing code ${phoneNumber} from ${lock.name}`)
                    return cb()
                })
            }, cb)
        }
    ], cb)
}

const schedules = {};


const log = (logMsg) => {
    const now = moment().format('Y-MM-DD h:mm A');
    console.log(`${now} - ${logMsg}`);
};


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


const getiCalEvents = (cb) => {
    const events = [];
    let retryCount = 0;
    // I've had errors with AirBnb's iCal not returning any events.  If this happens, I retry.
    async.mapSeries(config.get('calendarUrl'), (calUrl, cb) => {
        async.retry({
            times: 60,
            interval: 1000
        }, (cb) => {
            retryCount++;
            if (retryCount == 1) {
                log('Getting events..');
            } else {
                log('Getting events (retrying)..');
            }
            ical.fromURL(calUrl, {}, (err, data) => {
                if (err) return cb(err);
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
                log(`Found ${events.length} events from calendar URL ${calUrl}`);
                return cb(null, events);
            });
        }, cb);
    }, cb);
};



const runCheckInActions = (ph, reservationNumber) => {
    async.eachSeries([
        (cb) => {
            setLockCode(ph, reservationNumber, cb)
        },
        (cb) => {
            let mode = config.get('checkin_mode')
            if (mode) {
                setMode(mode, cb)
            } else {
                return cb()
            }
        }
    ])
};


const runCheckOutActions = (ph, reservationNumber) => {
    async.eachSeries([
        (cb) => {
            removeLockCode(ph, reservationNumber, cb)
        },
        (cb) => {
            let mode = config.get('checkout_mode')
            if (mode) {
                setMode(mode, cb)
            } else {
                return cb()
            }
        }
    ])
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




const getSchedules = () => {
    log('Refreshing schedules');
    getiCalEvents((err, events) => {
        if (err) {
            return log('Error getting airbnb calendar events. Not modifying any schedules.');
        }

        events = events.flat();

        const currentCodes = [];
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
                currentCodes.push(phoneNumber);
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

        if (currentCodes.length == 0) {
            log('There should be zero codes programmed in the lock right now.');
        }

        if (currentCodes.length > 0) {
            log('The following codes should be active: ' + currentCodes);
        }
    });

};



log('Setting up cron job to check calendar every hour');


const job = schedule.scheduleJob(config.get('cron_schedule'), () => {
    getSchedules();
});

getSchedules();