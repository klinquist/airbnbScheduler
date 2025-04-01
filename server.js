const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const config = require('config');
const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.static('public'));

// Request logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    next();
});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get the configured timezone
app.get('/api/timezone', (req, res) => {
    res.json({ timezone: config.get('timezone') });
});

app.get('/api/visits', async (req, res) => {
    try {
        console.log('Fetching all scheduled visits...');
        const visits = await require('./index.js').readScheduledVisits();
        console.log(`Found ${visits.length} scheduled visits`);
        res.json(visits);
    } catch (error) {
        console.error('Error fetching scheduled visits:', error);
        res.status(500).json({ error: 'Failed to read scheduled visits' });
    }
});

app.post('/api/visits', async (req, res) => {
    try {
        console.log('Adding new scheduled visit:', req.body);
        const visit = await require('./index.js').addScheduledVisit(req.body);
        console.log('Successfully added visit:', visit);
        res.json(visit);
    } catch (error) {
        console.error('Error adding scheduled visit:', error);
        res.status(500).json({ error: 'Failed to save scheduled visit' });
    }
});

app.delete('/api/visits/:id', async (req, res) => {
    try {
        console.log(`Deleting scheduled visit with ID: ${req.params.id}`);
        await require('./index.js').deleteScheduledVisit(req.params.id);
        console.log('Successfully deleted visit');
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting scheduled visit:', error);
        res.status(500).json({ error: 'Failed to delete scheduled visit' });
    }
});

// Start the server
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at:`);
    console.log(`- Local: http://localhost:${port}`);
    console.log(`- Network: http://0.0.0.0:${port}`);
    console.log(`- Timezone: ${config.get('timezone')}`);
}); 