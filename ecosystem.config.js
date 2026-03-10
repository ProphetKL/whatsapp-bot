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
        // 认证凭据请在 .env 文件中配置，切勿在此填写
      },
    },
  ],
};
