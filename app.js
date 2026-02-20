require('dotenv').config();

// Export the Express app for Phusion Passenger (cPanel production).
// In development, index.js internally calls app.listen().
const app = require('./dist/index.js');

// Passenger expects module.exports to be the app
module.exports = app.default || app;
