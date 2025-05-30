// Simple logger utility
function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = data ? `${timestamp} [${level}] ${message} ${JSON.stringify(data)}` : `${timestamp} [${level}] ${message}`;
    console.log(logEntry);
  }
  
  module.exports = {
    info: (message, data) => log('INFO', message, data),
    error: (message, data) => log('ERROR', message, data),
    warn: (message, data) => log('WARN', message, data),
    debug: (message, data) => log('DEBUG', message, data)
  };
