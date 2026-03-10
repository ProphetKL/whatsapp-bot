module.exports = {
  apps: [
    {
      name: 'whatsapp-bot',
      script: 'src/index.js',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // AUTH_USER: 'admin',
        // AUTH_PASS: 'your_password_here',
      },
    },
  ],
};
