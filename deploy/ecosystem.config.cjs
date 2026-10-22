// pm2 process file: `pm2 start deploy/ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: 'franchise-routing',
      script: 'dist/src/server.js',
      cwd: __dirname + '/..',
      instances: 1, // the release job runs in-process; keep one instance
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
