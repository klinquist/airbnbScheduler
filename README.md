## Airbnb Scheduler

This script allows you to specify a check in time and a check out time, and runs functions if a guest is checking in or out that day.  This runs on a raspberry pi in my house.

I have SmartThings WebCoRE pistons set up to execute SmartThings routines when you GET a URL for check in and check out.  For check in, I turn on the thermostat, set the home to "Awaiting Guest" mode, etc.  For check out, I arm the alarm, turn down the thermostat, etc.


## Installation & Usage

* Git clone to a folder 
* Enter that folder and run `npm install`
* Edit the `config/default.json` to fit your needs
* Run `node index.js`.  

I recommend using a node process manager like _pm2_ to run it on startup.

Feel free to edit

## License
 
The MIT License (MIT)

Copyright (c) 2019 Kristopher Linquist

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.