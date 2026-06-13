module.exports = {
  apps: [
    {
      name: 'urvar-bot',
      script: 'dist/index.js',
      interpreter: 'node',
      restart_delay: 5000,
      max_restarts: 20,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/bot-out.log',
      error_file: './logs/bot-error.log',
    },
  ],
};
