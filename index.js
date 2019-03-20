




const ical = require('ical'),
    CronJob = require('cron').CronJob,
    async = require('async'),
    moment = require('moment-timezone'),
    request = require('request'),
    config = require('config');


const checkInFunction = () => {
    log('A guest is checking in today!  Running check-in function');
    const requestObj = {
        method: 'GET',
        uri: config.get('checkInRoutineUrl')
    };
    request(requestObj, (err, res, body) => {
        log(`Result: ${JSON.stringify(body)}`);
    });
};

const checkOutFunction = () => {
    log('A guest is checking out today!  Running check-out function');
    const requestObj = {
        method: 'GET',
        uri: config.get('checkOutRoutineUrl')
    };
    request(requestObj, (err, res, body) => {
        log(`Result: ${JSON.stringify(body)}`);
    });
};


const log = (logMsg) => {
    const now = moment().format('Y-MM-DD h:mm A');
    console.log(`${now} - ${logMsg}`);
};

const convertStrToCron = (str) => {
    str = str.replace(/\s/g, '').toUpperCase();
    const match = str.match(/(\d+):(\d+)(A|P)/);
    if (!match || !match[1] || !match[2] || !match[3]) throw new Error(`Could not convert time to cron format: ${str}`);
    let hr;
    if (match[3] == 'A' && Number(match[1]) == 12) {
        hr = 0;
    } else if (match[3] == 'P' && Number(match[1]) < 12) {
        hr = Number(match[1]) + 12;
    } else {
        hr = Number(match[1]);
    }
    return `0 ${Number(match[2])} ${hr} * * *`;
};



const getiCalEvents = (cb) => {
    const events = [];
    let retryCount = 0;
    // I've had errors with AirBnb's iCal not returning any events.  If this happens, I retry.
    async.retry({ times: 60, interval: 30000 }, (cb) => {
        retryCount++;
        if (retryCount == 1) {
            log('Getting events..');
        } else {
            log('Getting events (retrying)..');
        }
        ical.fromURL(config.get('calendarUrl'), {}, (err, data) => {
            if (err) return cb(err);
            if (!data || Object.keys(data) == 0) {
                return cb('No events returned');
            }
            for (var k in data) {
                if (data.hasOwnProperty(k)) {
                    var ev = data[k];
                    if (ev && ev.start && ev.summary && ev.summary !== 'Not available') {
                        events.push(ev);
                    }
                }
            }
            log(`Found ${events.length} events`);
            return cb(null, events);
        });
    }, cb);
};



log(`Setting cron job for ${config.get('arrivalScheduleTime')}: ${convertStrToCron(config.get('arrivalScheduleTime'))}`);
new CronJob(convertStrToCron(config.get('arrivalScheduleTime')), () => {
    getiCalEvents((err, events) => {
        if (err) log('Error getting events from iCal: ' + err);
        if (!events || events.length == 0) {
            log('No events found');
        } else {
            let runCheckin = false;
            events.forEach((event)=>{
                const daysDiff = moment(event.start).diff(moment().startOf('day'), 'days');
                if (daysDiff == 0) {
                    runCheckin = true;
                    log(`${event.summary} is checking in today!`);
                } else {
                    log(`Skipping - check in for ${event.summary} is ${daysDiff} days away.`);
                }
            });
            if (runCheckin) {
                checkInFunction();
            } else {
                log('Nobody is checking in today.');
            }
        }
    });
}, null, true, config.get('timezone'));


log(`Setting cron job for ${config.get('departureScheduleTime')}: ${convertStrToCron(config.get('departureScheduleTime'))}`);
new CronJob(convertStrToCron(config.get('departureScheduleTime')), () => {
    getiCalEvents((err, events) => {
        if (err) log('Error getting events from iCal: ' + err);
        if (!events || events.length == 0) {
            log('No events found');
        } else {
            let runCheckOut = false;
            events.forEach((event) =>{
                const daysDiff = moment(event.end).diff(moment().startOf('day'), 'days');
                if (daysDiff == 0) {
                    log(`${event.summary} is checking out today!`);
                    runCheckOut = true;
                } else {
                    log(`Skipping - check out for ${event.summary} is ${daysDiff} days away.`);
                }
            });
            if (runCheckOut) {
                checkOutFunction();
            } else {
                log('Nobody is checking out today.');
            }
        }
    });
}, null, true, config.get('timezone'));


